use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{
    sse::{Event, KeepAlive, Sse},
    Json,
};
use reqwest::header::{HeaderName, HeaderValue, RANGE};
use serde::Deserialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use crate::daemon::curl::{
    create_curl_task as direct_create, curl_version, delete_task, list_all_tasks, pause_task,
    resume_task,
};
use crate::daemon::engine::bandwidth::ScheduleLimit;
use crate::daemon::engine::checksum::{self, ChecksumAlgorithm};
use crate::daemon::engine::metadata_cache::CachedMetadata;
use crate::daemon::engine::mirror::{MirrorManager, MirrorSource};
use crate::daemon::engine::plugin_api::PluginManifest;
use crate::daemon::engine::priority_queue::{DownloadPriority, QueueEntry};
use crate::daemon::engine::retry::RetryPolicy;
use crate::daemon::engine::rules::{DownloadRule, RuleAction};
use crate::daemon::engine::scheduler::{SchedulerAction, SchedulerRule};
use crate::daemon::state::SharedState;
use crate::daemon::telegram::telegram_notify;
use crate::daemon::types::{CreateDownloadBody, Task, TorrentConfigBody};
use crate::daemon::utils::DEFAULT_USER_AGENT;
use crate::daemon::utils::{hide_command_window, infer_file_type};
use crate::daemon::ytdlp::create_ytdlp_task;
use crate::lock_or_err;

const PROBE_HEAD_TIMEOUT_SECS: u64 = 15;
const PROBE_RANGE_TIMEOUT_SECS: u64 = 20;
const PROBE_USER_AGENT: &str = DEFAULT_USER_AGENT;

fn daemon_error(message: String) -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": message})),
    )
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

pub async fn handle_engine_capabilities(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let mut status = (*state.engine_capabilities()).clone();
    let extractors: Vec<serde_json::Value> = state
        .extractor_registry
        .all()
        .iter()
        .map(|ext| {
            let es = ext.engine_status(&state);
            serde_json::json!({
                "id": es.id,
                "name": es.name,
                "available": es.available,
                "version": es.version,
                "features": es.features,
            })
        })
        .collect();
    if let Some(obj) = status.as_object_mut() {
        obj.insert(
            "extractors".to_string(),
            serde_json::Value::Array(extractors),
        );
    }
    Json(status)
}

fn bool_from_status(status: &serde_json::Value, pointer: &str) -> bool {
    status
        .pointer(pointer)
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn extension_capabilities_from_status(status: &serde_json::Value) -> serde_json::Value {
    let direct_ready = bool_from_status(status, "/directReady");
    let media_ready = bool_from_status(status, "/mediaReady");
    let post_ready = bool_from_status(status, "/postProcessingReady");
    let hls_ready = media_ready && post_ready;
    let dash_ready = media_ready && post_ready;
    let mut items = Vec::new();
    if direct_ready {
        items.push("candidate.directUrl");
    }
    if direct_ready || media_ready {
        items.push("task.add");
        items.push("task.addBatch");
        items.push("task.pause");
        items.push("task.resume");
        items.push("task.cancel");
    }
    if hls_ready {
        items.push("candidate.hls");
        items.push("stream.hls.detect");
        items.push("stream.hls.resolve");
        items.push("stream.hls.download");
    }
    if dash_ready {
        items.push("candidate.dash");
        items.push("stream.dash.detect");
        items.push("stream.dash.resolve");
        items.push("stream.dash.download");
    }
    if hls_ready || dash_ready {
        items.push("stream.quality.select");
        if post_ready {
            items.push("stream.subtitles");
            items.push("stream.audioTracks");
        }
    }
    items.push("events.sse");
    items.push("settings.snapshot");
    items.sort();
    items.dedup();
    let direct_protocols = status
        .pointer("/engines/libcurlMulti/protocols")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let stream_resolver_ready = hls_ready || dash_ready;
    serde_json::json!({
        "items": items,
        "engineCapabilities": status,
        "directOptionKeys": status.pointer("/engines/libcurlMulti/supportedDirectOptionKeys").cloned().unwrap_or_else(|| serde_json::json!([])),
        "mediaOptionKeys": status.pointer("/engines/ytdlp/supportedMediaOptionKeys").cloned().unwrap_or_else(|| serde_json::json!([])),
        "directProtocols": direct_protocols,
        "streamResolverReady": stream_resolver_ready,
        "unsupportedCandidateMediaTypes": ["torrent", "magnet"],
        "sourceOfTruth": "daemon-runtime-linked-libcurl-and-engine-probes"
    })
}

pub async fn handle_v1_ping(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
    Json(serde_json::json!({
        "ok": true,
        "app": "NOVA",
        "appVersion": env!("CARGO_PKG_VERSION"),
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "browserIntegrationEnabled": true,
        "status": status.get("status").cloned().unwrap_or_else(|| serde_json::json!("degraded")),
        "capabilities": extension_capabilities_from_status(&status)
    }))
}

pub async fn handle_v1_pair_auto(Json(_body): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let token = format!(
        "nova-local-pair-{}",
        uuid::Uuid::new_v4().to_string().replace('-', "")
    );
    Json(serde_json::json!({
        "ok": true,
        "pairToken": token,
        "autoApproved": true,
        "method": "auto-localhost-runtime-verified",
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "ttlSeconds": 60 * 60 * 24 * 30
    }))
}

pub async fn handle_v1_auth_check(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
    Json(serde_json::json!({
        "ok": true,
        "protocolVersion": 4,
        "minimumSupportedProtocolVersion": 4,
        "scopes": ["task.add", "task.addBatch", "task.pause", "task.resume", "task.cancel", "events.sse", "settings.snapshot"],
        "capabilities": extension_capabilities_from_status(&status)
    }))
}

pub async fn handle_v1_extension_settings(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let status = state.engine_capabilities();
    Json(serde_json::json!({
        "ok": true,
        "capabilities": extension_capabilities_from_status(&status),
        "settings": {
            "captureEndpoint": "/captures",
            "directEngine": "libcurl-multi",
            "mediaEngine": "yt-dlp",
            "postProcessor": "ffmpeg",
            "torrentMagnet": false
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
        let mut last_snapshots: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let mut full_sync_counter: u32 = 0;

        loop {
            interval.tick().await;
            let tasks = list_all_tasks(&state).await;

            // Every 40 ticks (~10 seconds), send a full sync so the frontend can
            // reconcile any missed events or ghost entries.
            full_sync_counter += 1;
            if full_sync_counter >= 40 {
                full_sync_counter = 0;
                let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
                last_snapshots.clear();
                for t in &tasks {
                    last_snapshots.insert(t.id.clone(), 0); // store id as "I exist" marker
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
/// register, and the per-task rate limit — or an error for `Reject` rules.
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

    if body.media_options.is_none() {
        resolve_direct_body_for_immediate_download(&state, &mut body).await;
    }

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
            register_task_with_engine(&state, &task, rule_priority, rule_mirrors, rule_rate_limit);
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

fn save_torrent_config(state: &SharedState) {
    {
        let tc = lock_or_err!(state.torrent_config);
        let path = std::path::Path::new(&state.data_dir).join("torrent-config.json");
        match serde_json::to_string_pretty(&*tc) {
            Ok(payload) => {
                if let Err(e) = std::fs::write(&path, &payload) {
                    log::error!("Failed to write torrent config: {e}");
                }
            }
            Err(e) => log::error!("Failed to serialize torrent config: {e}"),
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
        let mut tc = lock_or_err!(state.torrent_config);
        if let Some(v) = body.dht {
            tc.dht = Some(v);
        }
        if let Some(v) = body.pex {
            tc.pex = Some(v);
        }
        if let Some(v) = body.encryption {
            tc.encryption = Some(v);
        }
        if let Some(v) = body.listen_port {
            tc.listen_port = Some(v);
        }
        if let Some(v) = body.max_peers {
            tc.max_peers = Some(v);
        }
        if let Some(v) = body.seeding {
            tc.seeding = Some(v);
        }
        if let Some(v) = body.ratio_limit {
            tc.ratio_limit = Some(v);
        }
        if let Some(v) = body.upload_speed {
            tc.upload_speed = Some(v);
        }
    }
    save_torrent_config(&state);
    Json(serde_json::json!({"ok": true, "saved": true}))
}

fn header_string(headers: &reqwest::header::HeaderMap, key: &str) -> String {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

fn header_u64(headers: &reqwest::header::HeaderMap, key: &str) -> u64 {
    headers
        .get(key)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0)
}

/// Try multiple well-known header names that servers use to report file size.
/// Priority: Content-Range total > Content-Length > X-Content-Length >
/// x-uncompressed-content-length > X-File-Size > X-Full-Content-Length.
fn extract_best_size(headers: &reqwest::header::HeaderMap, content_range: &str) -> u64 {
    let from_range = content_range_total(content_range);
    if from_range > 0 {
        return from_range;
    }
    for key in &[
        "content-length",
        "x-content-length",
        "x-uncompressed-content-length",
        "x-file-size",
        "x-full-content-length",
        "x-original-content-length",
        "x-compressed-content-length",
    ] {
        let v = header_u64(headers, key);
        if v > 0 {
            return v;
        }
    }
    0
}

fn content_range_total(content_range: &str) -> u64 {
    content_range
        .rsplit('/')
        .next()
        .map(str::trim)
        .filter(|value| *value != "*")
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

fn content_disposition_filename(value: &str) -> Option<String> {
    for part in value.split(';') {
        let trimmed = part.trim();
        if let Some(name) = trimmed.strip_prefix("filename*=") {
            // RFC 5987: charset'language'value — take the part after the language tag
            let raw = name
                .split("''")
                .last()
                .unwrap_or(name)
                .trim_matches('"')
                .trim();
            if raw.is_empty() {
                continue;
            }
            // URL-decode the value (percent-encoded per RFC 5987)
            let decoded = percent_decode_str(raw);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    // Second pass: plain filename= (lower priority than filename*)
    for part in value.split(';') {
        let trimmed = part.trim();
        if let Some(name) = trimmed.strip_prefix("filename=") {
            let name = name.trim_matches('"').trim();
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    None
}

/// Percent-decode a string (e.g. `%20` → ` `). Falls back to the original on failure.
fn percent_decode_str(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(byte) = hex_pair_to_byte(bytes[i + 1], bytes[i + 2]) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        // Convert single byte to UTF-8 character safely
        if let Some(ch) = std::char::from_u32(bytes[i] as u32) {
            for b in ch.to_string().as_bytes() {
                result.push(*b);
            }
        }
        i += 1;
    }
    String::from_utf8(result).unwrap_or_else(|_| input.to_string())
}

fn hex_pair_to_byte(high: u8, low: u8) -> Option<u8> {
    fn hex_digit(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    Some((hex_digit(high)? << 4) | hex_digit(low)?)
}

fn fallback_file_name(url: &str) -> String {
    let clean = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    let name = clean.rsplit('/').next().unwrap_or("download").trim();
    if name.is_empty() {
        "download".to_string()
    } else {
        name.to_string()
    }
}

/// Parse HTML content for `<meta http-equiv="refresh" content="5;URL='...'">`
/// patterns commonly used by VideoLAN and similar mirrors that redirect via
/// HTML rather than HTTP 3xx. Returns the redirected URL if found.
fn parse_meta_refresh_url(html: &str) -> Option<String> {
    // Case-insensitive search for meta refresh tags
    let lower = html.to_ascii_lowercase();
    // Match: <meta http-equiv="refresh" content="N;URL='...'">
    // Also handles: <meta http-equiv="refresh" content="N; url=...">
    let patterns = ["url='", "url=\"", "url="];
    for tag_match in lower.match_indices("<meta") {
        let start = tag_match.0;
        // Find the closing > of this tag
        if let Some(end) = lower[start..].find('>') {
            let tag = &lower[start..start + end + 1];
            if tag.contains("http-equiv") && tag.contains("refresh") {
                for pat in &patterns {
                    if let Some(pat_pos) = tag.rfind(pat) {
                        let value_start = pat_pos + pat.len();
                        let remaining = &tag[value_start..];
                        let value = if *pat == "url='" || *pat == "url=\"" {
                            let quote = if pat.ends_with('\'') { '\'' } else { '"' };
                            if let Some(q_end) = remaining.find(quote) {
                                &remaining[..q_end]
                            } else {
                                remaining.trim_end_matches('>')
                            }
                        } else {
                            remaining.trim_end_matches('>').trim()
                        };
                        let value = value.trim();
                        if !value.is_empty() {
                            return Some(value.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Check if a response body contains Cloudflare challenge indicators.
/// Cloudflare bot protection returns HTML with challenge scripts and
/// specific markers like `cf-chl-bypass`, `challenge-platform`, etc.
fn is_cloudflare_challenge(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("cf-chl-bypass")
        || lower.contains("challenge-platform")
        || lower.contains("cf_chl_opt")
        || (lower.contains("cloudflare") && lower.contains("challenge") && lower.contains("<script"))
}

/// For SourceForge URLs, try the direct downloads subdomain which often
/// bypasses Cloudflare protection.
fn sourceforge_direct_url(url: &str) -> Option<String> {
    if !url.contains("sourceforge.net") {
        return None;
    }
    // https://sourceforge.net/projects/foo/files/bar.exe/download
    // -> https://downloads.sourceforge.net/project/foo/bar.exe
    if let Some(files_pos) = url.find("/files/") {
        let base = &url[..files_pos];
        let project = base.rsplit('/').next()?;
        let after_files = &url[files_pos + 7..].trim_end_matches("/download");
        if after_files.is_empty() {
            return None;
        }
        Some(format!(
            "https://downloads.sourceforge.net/project/{}/{}",
            project, after_files
        ))
    } else {
        None
    }
}

/// Resolve a meta-refresh redirect URL relative to the page URL if needed.
fn refreshed_url(refresh: String, page_url: &str) -> String {
    if refresh.starts_with("http://") || refresh.starts_with("https://") {
        refresh
    } else if let Some(base) = page_url.rsplit_once('/') {
        format!("{}/{}", base.0.trim_end_matches('/'), refresh.trim_start_matches('/'))
    } else {
        refresh
    }
}

fn probe_payload(
    url: &str,
    final_url: &str,
    headers: &reqwest::header::HeaderMap,
    status: u16,
    method: &str,
) -> serde_json::Value {
    let content_type = header_string(headers, "content-type");
    let accept_ranges = header_string(headers, "accept-ranges");
    let content_range = header_string(headers, "content-range");
    let content_disposition = header_string(headers, "content-disposition");
    let etag = header_string(headers, "etag");
    let last_modified = header_string(headers, "last-modified");
    // Accept-Ranges: bytes OR a Content-Range response means range support
    let supports_ranges = accept_ranges.eq_ignore_ascii_case("bytes")
        || content_range.to_ascii_lowercase().starts_with("bytes ");
    // Use the best available size across all known header variants
    let size = extract_best_size(headers, &content_range);
    let final_name = content_disposition_filename(&content_disposition)
        .unwrap_or_else(|| fallback_file_name(final_url));

    serde_json::json!({
        "url": url,
        "finalUrl": final_url,
        "fileName": final_name,
        "fileType": infer_file_type(&final_name),
        "sizeBytes": size,
        "resumable": supports_ranges || status == 206,
        "supportsSegments": (supports_ranges || status == 206) && size > 0,
        "acceptRanges": accept_ranges,
        "contentRange": content_range,
        "contentType": content_type,
        "contentDisposition": content_disposition,
        "etag": etag,
        "lastModified": last_modified,
        "httpStatus": status,
        "probeMethod": method,
    })
}

fn json_non_empty_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn supported_direct_url(url: &str) -> bool {
    url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("ftps://")
        || url.starts_with("sftp://")
        || url.starts_with("scp://")
}

fn probe_payload_is_download(payload: &serde_json::Value) -> bool {
    let size = payload
        .get("sizeBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let content_disposition = json_non_empty_str(payload, "contentDisposition").unwrap_or("");
    let content_type = json_non_empty_str(payload, "contentType")
        .unwrap_or("")
        .to_ascii_lowercase();

    size > 0
        || !content_disposition.is_empty()
        || (!content_type.is_empty() && !content_type.starts_with("text/html"))
}

fn body_name_should_follow_probe(current_name: Option<&str>, original_url: &str) -> bool {
    let Some(current_name) = current_name.map(str::trim).filter(|v| !v.is_empty()) else {
        return true;
    };
    current_name.eq_ignore_ascii_case("download")
        || current_name.eq_ignore_ascii_case(&fallback_file_name(original_url))
}

fn save_path_with_probe_name(
    save_path: &str,
    original_url: &str,
    probe_name: &str,
) -> Option<String> {
    let current_name = PathBuf::from(save_path)
        .file_name()
        .and_then(|v| v.to_str())
        .map(str::to_string)?;
    if !body_name_should_follow_probe(Some(&current_name), original_url) {
        return None;
    }
    let mut path = PathBuf::from(save_path);
    path.set_file_name(probe_name);
    Some(path.to_string_lossy().to_string())
}

async fn resolve_direct_body_for_immediate_download(
    state: &SharedState,
    body: &mut CreateDownloadBody,
) {
    if !body.start_immediately.unwrap_or(true) {
        return;
    }

    let Some(original_url) = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
    else {
        return;
    };
    if !supported_direct_url(&original_url) {
        return;
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
            return;
        }
    }

    let Ok(Json(payload)) = probe_url_with_options(state, &original_url, Some(&*body)).await else {
        return;
    };
    let Some(final_url) = json_non_empty_str(&payload, "finalUrl").map(str::to_string) else {
        return;
    };
    if final_url == original_url
        || !supported_direct_url(&final_url)
        || !probe_payload_is_download(&payload)
    {
        return;
    }

    if body
        .referer
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        body.referer = Some(original_url.clone());
    }
    if body.size_bytes.unwrap_or(0) == 0 {
        if let Some(size) = payload
            .get("sizeBytes")
            .and_then(|v| v.as_u64())
            .filter(|v| *v > 0)
        {
            body.size_bytes = Some(size);
        }
    }
    if body.resumable.is_none() {
        body.resumable = payload.get("resumable").and_then(|v| v.as_bool());
    }
    if let Some(probe_name) = json_non_empty_str(&payload, "fileName") {
        if body_name_should_follow_probe(body.name.as_deref(), &original_url) {
            body.name = Some(probe_name.to_string());
        }
        if let Some(save_path) = body.save_path.as_deref() {
            if let Some(next_path) = save_path_with_probe_name(save_path, &original_url, probe_name)
            {
                body.save_path = Some(next_path);
            }
        }
    }

    body.url = Some(final_url);
}

fn direct_option_str<'a>(body: &'a CreateDownloadBody, key: &str) -> Option<&'a str> {
    body.direct_options
        .as_ref()
        .and_then(|opts| opts.get(key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn probe_http_client(state: &SharedState, body: Option<&CreateDownloadBody>) -> reqwest::Client {
    let Some(body) = body else {
        return state.http_client.clone();
    };
    let mut builder = reqwest::Client::builder();
    if let Some(proxy) = direct_option_str(body, "proxy") {
        if let Ok(proxy) = reqwest::Proxy::all(proxy) {
            builder = builder.proxy(proxy);
        }
    }
    if let Some(source) =
        direct_option_str(body, "sourceAddress").or_else(|| direct_option_str(body, "interface"))
    {
        if let Ok(addr) = source.parse::<std::net::IpAddr>() {
            builder = builder.local_address(addr);
        }
    }
    builder
        .build()
        .unwrap_or_else(|_| state.http_client.clone())
}

fn apply_probe_request_options(
    mut request: reqwest::RequestBuilder,
    body: Option<&CreateDownloadBody>,
) -> reqwest::RequestBuilder {
    let Some(body) = body else {
        return request;
    };
    if let Some(user_agent) = direct_option_str(body, "userAgent") {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    if let Some(referer) = direct_option_str(body, "referer").or(body.referer.as_deref()) {
        request = request.header(reqwest::header::REFERER, referer);
    }
    if let Some(cookies) = direct_option_str(body, "cookies") {
        request = request.header(reqwest::header::COOKIE, cookies);
    }
    if let Some(raw_headers) = direct_option_str(body, "headers") {
        for line in raw_headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(name.trim().as_bytes()),
                HeaderValue::from_str(value.trim()),
            ) {
                request = request.header(name, value);
            }
        }
    }
    request
}

/// Stage 1 of the smart probe: HEAD request
/// Returns the final URL after redirects (if HEAD succeeded), or None.
/// Sets `best_payload` if size was obtained.
async fn probe_stage_head(
    client: &reqwest::Client,
    url: &str,
    body: Option<&CreateDownloadBody>,
    best_payload: &mut Option<serde_json::Value>,
) -> Option<String> {
    match apply_probe_request_options(
        client
            .head(url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .timeout(Duration::from_secs(PROBE_HEAD_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let final_url = resp.url().to_string();
            if status < 400 {
                let payload = probe_payload(url, &final_url, resp.headers(), status, "HEAD");
                let has_size = payload
                    .get("sizeBytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    > 0;
                let has_range = payload
                    .get("supportsSegments")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if has_size && (has_range || best_payload.is_none()) {
                    *best_payload = Some(payload);
                }
                Some(final_url)
            } else {
                log::warn!(
                    "probe HEAD {} -> {} {}",
                    url,
                    status,
                    resp.status().canonical_reason().unwrap_or("")
                );
                best_payload.as_ref().map(|_| final_url)
            }
        }
        Err(e) => {
            log::warn!("probe HEAD {} failed: {}", url, e);
            None
        }
    }
}

/// 4-stage smart URL probe:
/// 1. HEAD with browser UA (fast, minimal traffic)
/// 2. GET bytes=0-0 (reveals Accept-Ranges + Content-Range total even when HEAD is blocked)
/// 3. GET bytes=0-1023 + abort after headers (rare fallback for servers that lie in HEAD)
/// 4. Synthetic fallback – at least provide filename/type from URL so the UI
///    stays functional even for opaque download links.
fn probe_payload_from_cache(cached: &CachedMetadata) -> serde_json::Value {
    let final_url = cached
        .headers
        .get("finalUrl")
        .cloned()
        .unwrap_or_else(|| cached.url.clone());
    serde_json::json!({
        "url": cached.url,
        "finalUrl": final_url,
        "fileName": cached.filename,
        "fileType": infer_file_type(&cached.filename),
        "sizeBytes": cached.content_length.unwrap_or(0),
        "resumable": cached.accept_ranges,
        "supportsSegments": cached.accept_ranges,
        "contentType": cached.content_type.clone().unwrap_or_default(),
        "acceptRanges": if cached.accept_ranges { "bytes" } else { "" },
        "etag": cached.etag.clone().unwrap_or_default(),
        "lastModified": cached.last_modified.clone().unwrap_or_default(),
        "probeMethod": "metadata-cache"
    })
}

fn cache_probe_payload(state: &SharedState, url: &str, payload: &serde_json::Value) {
    let size = payload
        .get("sizeBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let method = payload
        .get("probeMethod")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if size == 0 || method.starts_with("fallback") {
        return;
    }
    let get_str = |key: &str| {
        payload
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let mut headers = HashMap::new();
    if let Some(final_url) = get_str("finalUrl") {
        headers.insert("finalUrl".to_string(), final_url);
    }
    state.metadata_cache.put(CachedMetadata {
        url: url.to_string(),
        filename: get_str("fileName").unwrap_or_default(),
        content_type: get_str("contentType").filter(|v| !v.is_empty()),
        content_length: Some(size),
        etag: get_str("etag").filter(|v| !v.is_empty()),
        last_modified: get_str("lastModified").filter(|v| !v.is_empty()),
        accept_ranges: payload
            .get("resumable")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        checksum: None,
        headers,
        cached_at: chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string(),
    });
}

async fn probe_url_with_options(
    state: &SharedState,
    url: &str,
    body: Option<&CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }

    // SSRF protection: reject URLs targeting internal networks
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    // Serve recent probe results from the metadata cache to avoid re-hitting
    // origin servers for the same URL (probe → add-download double request).
    if let Some(cached) = state.metadata_cache.get(url) {
        return Ok(Json(probe_payload_from_cache(&cached)));
    }

    let result = probe_url_uncached(state, url, body).await;
    if let Ok(Json(payload)) = &result {
        cache_probe_payload(state, url, payload);
    }
    result
}

async fn probe_url_uncached(
    state: &SharedState,
    url: &str,
    body: Option<&CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let client = probe_http_client(state, body);
    let mut best_payload: Option<serde_json::Value> = None;

    // ── Stage 1: HEAD ──────────────────────────────────────────────────────
    let final_url = probe_stage_head(&client, url, body, &mut best_payload).await;

    // ── Stage 2: GET bytes=0-0 (single byte range) ────────────────────────
    let target_url = final_url.as_deref().unwrap_or(url);
    if let Ok(resp) = apply_probe_request_options(
        client
            .get(target_url)
            .header(RANGE, "bytes=0-0")
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        let status = resp.status().as_u16();
        let stage_final = resp.url().to_string();
        if status == 206 || status == 416 {
            let payload = probe_payload(url, &stage_final, resp.headers(), status, "GET range=0-0");
            return Ok(Json(payload));
        }
        if status < 400 {
            let payload = probe_payload(
                url,
                &stage_final,
                resp.headers(),
                status,
                "GET range=0-0 (no-range)",
            );
            let has_size = payload
                .get("sizeBytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                > 0;
            if has_size && best_payload.is_none() {
                best_payload = Some(payload);
            }
        }
        if status >= 400 {
            log::warn!(
                "probe GET range=0-0 {} -> {} {}",
                url,
                status,
                resp.status().canonical_reason().unwrap_or("")
            );
        }
    }

    // ── Stage 3: GET bytes=0-1023 (larger range peek) ─────────────────────
    if best_payload.is_none() {
        if let Ok(resp) = apply_probe_request_options(
            client
                .get(target_url)
                .header(RANGE, "bytes=0-1023")
                .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                .header(reqwest::header::ACCEPT, "*/*")
                .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
            body,
        )
        .send()
        .await
        {
            let status = resp.status().as_u16();
            let stage_final = resp.url().to_string();
            if status == 206 || status < 400 {
                let payload = probe_payload(
                    url,
                    &stage_final,
                    resp.headers(),
                    status,
                    "GET range=0-1023",
                );
                let has_size = payload
                    .get("sizeBytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0)
                    > 0;
                if has_size {
                    return Ok(Json(payload));
                }
                if best_payload.is_none() {
                    best_payload = Some(payload);
                }
            }
        }
    }

    // Return the best partial result we collected.
    if let Some(payload) = best_payload {
        return Ok(Json(payload));
    }

    // ── Stage 3b: Plain GET with Accept-Encoding (fallback) ────────────────
    // Some CDNs (CloudFront, Akamai) block requests without a proper
    // Accept-Encoding header or without Range. Try a plain GET with
    // browser-like encoding and abort headers-only.
    let _stage3b_body = if let Ok(resp) = apply_probe_request_options(
        client
            .get(target_url)
            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
            .header(reqwest::header::ACCEPT, "*/*")
            .header(reqwest::header::ACCEPT_ENCODING, "gzip, deflate, br")
            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
        body,
    )
    .send()
    .await
    {
        let status = resp.status().as_u16();
        let stage_final = resp.url().to_string();
        let status_reason = resp.status().canonical_reason().unwrap_or("").to_string();
        let content_type = header_string(resp.headers(), "content-type");
        let headers_snapshot = resp.headers().clone();
        let body_text = resp.text().await.unwrap_or_default();
        if status < 400 {
            let payload =
                probe_payload(url, &stage_final, &headers_snapshot, status, "GET (encoding)");
            let has_size = payload
                .get("sizeBytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                > 0;
            if has_size {
                return Ok(Json(payload));
            }
            // If body is HTML, try to extract meta-refresh URL (VideoLAN pattern)
            if content_type.contains("text/html") || body_text.trim_start().starts_with("<!DOCTYPE")
                || body_text.trim_start().starts_with("<html")
            {
                if let Some(refresh_url) = parse_meta_refresh_url(&body_text) {
                    log::info!(
                        "probe meta-refresh redirect for {}: {}",
                        url,
                        refresh_url
                    );
                    // Follow the meta-refresh URL with a new GET request
                    if let Ok(refreshed) = apply_probe_request_options(
                        client
                            .get(&refreshed_url(refresh_url, &stage_final))
                            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                            .header(reqwest::header::ACCEPT, "*/*")
                            .header(RANGE, "bytes=0-0")
                            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
                        body,
                    )
                    .send()
                    .await
                    {
                        let r_status = refreshed.status().as_u16();
                        let r_final = refreshed.url().to_string();
                        if r_status == 206 || r_status == 416 || r_status < 400 {
                            let payload = probe_payload(
                                url,
                                &r_final,
                                refreshed.headers(),
                                r_status,
                                "GET meta-refresh range=0-0",
                            );
                            return Ok(Json(payload));
                        }
                    }
                }
            }
            // Check for Cloudflare challenge (SourceForge pattern)
            if is_cloudflare_challenge(&body_text) {
                log::info!("probe Cloudflare challenge detected for {}", url);
                if let Some(direct_url) = sourceforge_direct_url(url) {
                    log::info!("probe trying SourceForge direct URL: {}", direct_url);
                    if let Ok(direct_resp) = apply_probe_request_options(
                        client
                            .get(&direct_url)
                            .header(reqwest::header::USER_AGENT, PROBE_USER_AGENT)
                            .header(reqwest::header::ACCEPT, "*/*")
                            .header(RANGE, "bytes=0-0")
                            .timeout(Duration::from_secs(PROBE_RANGE_TIMEOUT_SECS)),
                        body,
                    )
                    .send()
                    .await
                    {
                        let d_status = direct_resp.status().as_u16();
                        let d_final = direct_resp.url().to_string();
                        if d_status == 206 || d_status < 400 {
                            let payload = probe_payload(
                                url,
                                &d_final,
                                direct_resp.headers(),
                                d_status,
                                "GET sourceforge-direct",
                            );
                            return Ok(Json(payload));
                        }
                    }
                }
            }
        } else {
            log::warn!(
                "probe GET (encoding) {} -> {} {}",
                url,
                status,
                status_reason
            );
        }
        body_text
    } else {
        String::new()
    };

    // ── Stage 4: Synthetic fallback ────────────────────────────────────────
    // All network attempts failed (timeout / DNS / TLS / 4xx-5xx).
    // Return minimal metadata derived from the URL alone so the UI can still
    // show a sensible filename and file type without crashing.
    let fname = fallback_file_name(url);
    Ok(Json(serde_json::json!({
        "url": url,
        "finalUrl": url,
        "fileName": fname,
        "fileType": infer_file_type(&fname),
        "sizeBytes": 0,
        "resumable": false,
        "supportsSegments": false,
        "contentType": "",
        "acceptRanges": "",
        "etag": "",
        "lastModified": "",
        "probeMethod": "fallback-no-response"
    })))
}

pub async fn handle_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    probe_url_with_options(&state, url, None).await
}

pub async fn handle_probe_post(
    State(state): State<SharedState>,
    Json(body): Json<CreateDownloadBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url_owned = body.url.clone().unwrap_or_default();
    let url = url_owned.trim();
    probe_url_with_options(&state, url, Some(&body)).await
}

pub async fn handle_ytdlp_probe(
    Query(params): Query<HashMap<String, String>>,
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let url = params.get("url").map(|s| s.as_str()).unwrap_or("");
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if url.starts_with('-') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid url"})),
        ));
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked yt-dlp probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &["--dump-json", "--no-playlist", "--no-warnings", "--", &url2],
            )
        }),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({"error": "Probe timed out"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe stderr: {}", stderr);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Probe failed"})),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let info: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        log::error!("yt-dlp probe parse failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    let duration = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let hours = (duration / 3600.0).floor();
    let minutes = ((duration % 3600.0) / 60.0).floor();
    let seconds = (duration % 60.0).floor();
    let duration_str = if hours > 0.0 {
        format!(
            "{:02}:{:02}:{:02}",
            hours as u64, minutes as u64, seconds as u64
        )
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
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing url"})),
        ));
    }
    if url.starts_with('-') {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid url"})),
        ));
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked yt-dlp playlist probe of unsafe URL {}: {}", url, e);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        ));
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &[
                    "--flat-playlist",
                    "--dump-json",
                    "--no-warnings",
                    "--",
                    &url2,
                ],
            )
        }),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            Json(serde_json::json!({"error": "Probe timed out"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp spawn failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?
    .map_err(|e| {
        log::error!("yt-dlp probe failed: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Probe failed"})),
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::error!("yt-dlp probe playlist stderr: {}", stderr);
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Probe failed"})),
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut playlist_title = "Playlist".to_string();

    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(info) = serde_json::from_str::<serde_json::Value>(line) {
            if playlist_title == "Playlist" {
                playlist_title = info
                    .get("playlist_title")
                    .or(info.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Playlist")
                    .to_string();
            }
            let dur = info.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let hours = (dur / 3600.0).floor();
            let minutes = ((dur % 3600.0) / 60.0).floor();
            let seconds = (dur % 60.0).floor();
            let dur_str = if hours > 0.0 {
                format!(
                    "{:02}:{:02}:{:02}",
                    hours as u64, minutes as u64, seconds as u64
                )
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

pub async fn handle_ytdlp_ffmpeg(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let available = hidden_output(&state.ffmpeg_bin, &["-version"])
        .map(|o| o.status.success())
        .unwrap_or(false);
    Json(serde_json::json!({"available": available, "binary": state.ffmpeg_bin.clone()}))
}

fn read_browser_integration_state(data_dir: &str) -> (bool, bool) {
    let path = std::path::Path::new(data_dir).join("config.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return (true, false),
    };
    let cfg = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v,
        Err(_) => return (true, false),
    };
    let enabled = cfg
        .get("general")
        .and_then(|g| g.get("integrateWithBrowsers"))
        .and_then(|b| b.as_object())
        .map(|m| m.values().any(|v| v.as_bool() == Some(true)))
        .unwrap_or(true);
    let paired = cfg
        .get("extra")
        .and_then(|e| e.get("browserPairingToken"))
        .and_then(|t| t.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    (enabled, paired)
}

fn browser_ext_status(enabled: bool, paired: bool) -> &'static str {
    if enabled && paired {
        "connected"
    } else if enabled {
        "degraded"
    } else {
        "disconnected"
    }
}

pub async fn handle_browser_ext_config(
    State(state): State<SharedState>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let capabilities = state.engine_capabilities();
    let extension_capabilities = extension_capabilities_from_status(&capabilities);
    let (enabled, paired) = read_browser_integration_state(&state.data_dir);
    let status = browser_ext_status(enabled, paired);
    Json(serde_json::json!({
        "status": status,
        "enabled": enabled,
        "paired": paired,
        "version": env!("CARGO_PKG_VERSION"),
        "captureEndpoint": "/captures",
        "directDownloads": capabilities.get("directReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "mediaDownloads": capabilities.get("mediaReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "postProcessing": capabilities.get("postProcessingReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "directEngine": "libcurl-multi",
        "mediaEngine": "yt-dlp",
        "postProcessor": "ffmpeg",
        "engineCapabilities": capabilities,
        "capabilities": extension_capabilities
    }))
}

pub async fn handle_browser_ext_health(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let capabilities = state.engine_capabilities();
    let extension_capabilities = extension_capabilities_from_status(&capabilities);
    let (enabled, paired) = read_browser_integration_state(&state.data_dir);
    let status = browser_ext_status(enabled, paired);
    Json(serde_json::json!({
        "status": status,
        "enabled": enabled,
        "paired": paired,
        "version": env!("CARGO_PKG_VERSION"),
        "captureEndpoint": "/captures",
        "directDownloads": capabilities.get("directReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "mediaDownloads": capabilities.get("mediaReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "postProcessing": capabilities.get("postProcessingReady").cloned().unwrap_or(serde_json::Value::Bool(false)),
        "directEngine": "libcurl-multi",
        "mediaEngine": "yt-dlp",
        "postProcessor": "ffmpeg",
        "engineCapabilities": capabilities,
        "capabilities": extension_capabilities
    }))
}

use std::time::Instant;
static DAEMON_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

pub fn record_daemon_start() {
    DAEMON_START.get_or_init(Instant::now);
}

fn process_memory_usage_mb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kb = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    return kb / 1024;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = hidden_output(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[math]::Round((Get-Process -Id $PID).WorkingSet64 / 1MB)",
            ],
        ) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) =
            hidden_output("ps", &["-o", "rss=", "-p", &std::process::id().to_string()])
        {
            if output.status.success() {
                let kb = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
                return kb / 1024;
            }
        }
    }
    0
}

fn disk_free_gb(path: &str) -> u64 {
    #[cfg(target_os = "windows")]
    {
        let script = "$p=$args[0]; $drive=(Get-Item -LiteralPath $p).PSDrive; [math]::Round($drive.Free / 1GB)";
        if let Ok(output) = hidden_output(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", script, path],
        ) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = hidden_output("df", &["-Pk", path]) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = text.lines().nth(1) {
                    let kb = line
                        .split_whitespace()
                        .nth(3)
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    return kb / 1024 / 1024;
                }
            }
        }
    }
    0
}

fn network_interfaces() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = hidden_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.254*'} | ForEach-Object { $_.InterfaceAlias + '=' + $_.IPAddress }"]) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = hidden_output(
            "sh",
            &[
                "-c",
                "(ip -o -4 addr show 2>/dev/null || ifconfig 2>/dev/null) | head -n 40",
            ],
        ) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect();
            }
        }
    }
    Vec::new()
}

pub async fn handle_v1_list_tasks(State(state): State<SharedState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "tasks": list_all_tasks(&state).await}))
}

fn task_id_from_json(body: &serde_json::Value) -> Result<String, String> {
    body.get("taskId")
        .or_else(|| body.get("id"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
        .ok_or_else(|| "Missing taskId".to_string())
}

pub async fn handle_v1_pause_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match pause_task(&state, &id).await {
            Ok(task) => {
                Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Paused"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_resume_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match resume_task(&state, &id).await {
            Ok(task) => {
                Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Resumed"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_cancel_task_body(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    match task_id_from_json(&body) {
        Ok(id) => match delete_task(&state, &id, false).await {
            Ok(()) => {
                Json(serde_json::json!({"ok": true, "taskId": id, "message": "Removed from list"}))
            }
            Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
        },
        Err(error) => Json(serde_json::json!({"ok": false, "message": error})),
    }
}

pub async fn handle_v1_pause_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match pause_task(&state, &id).await {
        Ok(task) => Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Paused"})),
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_resume_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match resume_task(&state, &id).await {
        Ok(task) => Json(serde_json::json!({"ok": true, "taskId": task.id, "message": "Resumed"})),
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_cancel_task_path(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    match delete_task(&state, &id, false).await {
        Ok(()) => {
            Json(serde_json::json!({"ok": true, "taskId": id, "message": "Removed from list"}))
        }
        Err(error) => Json(serde_json::json!({"ok": false, "taskId": id, "message": error})),
    }
}

pub async fn handle_v1_events(
    State(state): State<SharedState>,
) -> Sse<impl futures_core::Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({"type":"connected", "at": now_str_for_events()}).to_string()));
        let mut last_payload = String::new();
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            let tasks = list_all_tasks(&state).await;
            let payload = serde_json::to_string(&tasks).unwrap_or_else(|_| "[]".to_string());
            if payload != last_payload {
                last_payload = payload;
                for task in &tasks {
                    let progress = if task.size_bytes > 0 { (task.downloaded_bytes as f64 / task.size_bytes as f64 * 100.0).clamp(0.0, 100.0) } else { 0.0 };
                    yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({
                        "type":"task.updated",
                        "taskId": task.id,
                        "status": task.status,
                        "progress": progress
                    }).to_string()));
                }
            } else {
                yield Ok::<Event, Infallible>(Event::default().data(serde_json::json!({"type":"heartbeat", "at": now_str_for_events()}).to_string()));
            }
        }
    };
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("keep-alive"),
    )
}

fn now_str_for_events() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub async fn handle_diagnostics(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let media_jobs_count = state.media_jobs.lock().map(|j| j.len()).unwrap_or(0);
    let curl_jobs_count = state.curl_jobs.lock().map(|j| j.len()).unwrap_or(0);
    let uptime_secs = DAEMON_START
        .get()
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);
    let engine_caps = state.engine_capabilities();
    let curl_available = engine_caps
        .pointer("/engines/curl/available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let ytdlp_available = engine_caps
        .pointer("/engines/ytdlp/available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let ffmpeg_available = engine_caps
        .pointer("/engines/ffmpeg/available")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Run full E2E diagnostics (with timeout)
    let diag = tokio::time::timeout(
        Duration::from_secs(45),
        crate::daemon::diagnostics::full_diagnostics(
            process_memory_usage_mb(),
            disk_free_gb(&state.data_dir),
            media_jobs_count + curl_jobs_count,
            curl_available,
            curl_version(),
            ytdlp_available,
            ffmpeg_available,
            network_interfaces(),
            uptime_secs,
            media_jobs_count,
            curl_jobs_count,
        ),
    )
    .await
    .unwrap_or_else(|_| {
        serde_json::json!({
            "summary": { "status": "timeout" },
            "error": "E2E diagnostics timed out after 45s"
        })
    });

    Json(diag)
}

pub async fn handle_post_diagnostics(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    log::info!(
        "Diagnostics received: {}",
        serde_json::to_string(&body).unwrap_or_default()
    );

    // Save report to file if requested
    if body.get("save").and_then(|v| v.as_bool()).unwrap_or(false) {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let filename = format!("nova-diagnostics-{}.json", timestamp);
        let report_path = std::path::Path::new(&state.data_dir)
            .join("diagnostics")
            .join(&filename);
        if let Some(parent) = report_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(
            &report_path,
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        ) {
            Ok(_) => {
                return Json(serde_json::json!({
                    "ok": true,
                    "saved": true,
                    "path": report_path.to_string_lossy(),
                    "filename": filename
                }));
            }
            Err(e) => {
                log::warn!("Failed to save diagnostics report: {}", e);
                return Json(serde_json::json!({
                    "ok": true,
                    "saved": false,
                    "error": format!("Failed to save: {}", e)
                }));
            }
        }
    }

    Json(serde_json::json!({"ok": true}))
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

fn json_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

fn map_candidate_file_type(media_type: &str, extension: Option<&str>) -> String {
    match media_type {
        "archive" => "compressed".to_string(),
        "app" => "program".to_string(),
        "document" | "video" | "audio" | "other" => media_type.to_string(),
        "image" => "other".to_string(),
        _ => match extension.unwrap_or("").to_ascii_lowercase().as_str() {
            "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "iso" => "compressed".to_string(),
            "exe" | "msi" | "apk" | "dmg" | "pkg" | "appimage" | "deb" | "rpm" => {
                "program".to_string()
            }
            "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "epub" => {
                "document".to_string()
            }
            "mp4" | "mkv" | "webm" | "avi" | "mov" | "m4v" | "flv" => "video".to_string(),
            "mp3" | "wav" | "flac" | "m4a" | "ogg" | "opus" | "aac" => "audio".to_string(),
            _ => "other".to_string(),
        },
    }
}

fn extension_candidate_to_download_body(
    body: &serde_json::Value,
    start_immediately: bool,
) -> Result<CreateDownloadBody, String> {
    let candidate = body.get("candidate").unwrap_or(body);
    let media_type = candidate
        .get("mediaType")
        .and_then(|v| v.as_str())
        .unwrap_or("other");
    let source = candidate
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if matches!(media_type, "torrent" | "magnet") {
        return Err(
            "Torrent and magnet candidates are not supported by the libcurl direct engine."
                .to_string(),
        );
    }
    let url = candidate
        .get("finalUrl")
        .or_else(|| candidate.get("url"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "Missing candidate URL".to_string())?;
    let is_stream_manifest =
        media_type == "manifest" || source == "hls-manifest" || source == "dash-manifest";
    if is_stream_manifest {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err("Only http(s) HLS/DASH manifests can be handed off to yt-dlp.".to_string());
        }
    } else if !(url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("ftp://")
        || url.starts_with("ftps://"))
    {
        return Err(
            "Only http(s)/ftp(s) candidates can be handed off to libcurl multi.".to_string(),
        );
    }
    let mut direct_options = body
        .get("directOptions")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .unwrap_or_default();
    let referer = candidate
        .get("referrer")
        .or_else(|| candidate.get("pageUrl"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if let Some(referrer) = referer.as_deref().filter(|v| !v.trim().is_empty()) {
        direct_options
            .entry("referer".to_string())
            .or_insert_with(|| serde_json::json!(referrer));
    }
    let media_options = if is_stream_manifest {
        let media = crate::daemon::types::MediaDownloadOptions {
            mode: Some("video".to_string()),
            playlist: Some(false),
            ffmpeg_enabled: Some(true),
            embed_metadata: Some(true),
            concurrent_fragments: Some(8),
            retries: Some(5),
            fragment_retries: Some(10),
            referer: referer.clone(),
            ..Default::default()
        };
        Some(media)
    } else {
        None
    };
    Ok(CreateDownloadBody {
        url: Some(url.to_string()),
        name: json_str(candidate, "filename").or_else(|| json_str(body, "name")),
        file_type: Some(if is_stream_manifest {
            "video".to_string()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        size_bytes: candidate
            .get("sizeBytes")
            .and_then(|v| v.as_u64())
            .or_else(|| body.get("sizeBytes").and_then(|v| v.as_u64())),
        category: Some(if is_stream_manifest {
            "video".to_string()
        } else {
            map_candidate_file_type(
                media_type,
                candidate.get("extension").and_then(|v| v.as_str()),
            )
        }),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        resumable: candidate
            .pointer("/headers/acceptRanges")
            .and_then(|v| v.as_str())
            .map(|v| v.eq_ignore_ascii_case("bytes"))
            .or_else(|| body.get("resumable").and_then(|v| v.as_bool())),
        save_path: json_str(body, "savePath"),
        description: json_str(body, "description").or_else(|| {
            Some(if is_stream_manifest {
                "Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_string()
            } else {
                "Browser extension capture via runtime-verified libcurl multi".to_string()
            })
        }),
        referer,
        start_immediately: Some(start_immediately),
        direct_options: if direct_options.is_empty() || media_options.is_some() {
            None
        } else {
            Some(direct_options)
        },
        media_options,
    })
}

fn legacy_v1_body_to_download_body(
    body: &serde_json::Value,
    start_immediately: bool,
) -> Result<CreateDownloadBody, String> {
    if body.get("candidate").is_some() {
        return extension_candidate_to_download_body(body, start_immediately);
    }
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if url.is_empty() {
        return Err("Missing url".to_string());
    }
    Ok(CreateDownloadBody {
        url: Some(url.to_string()),
        name: json_str(body, "name"),
        file_type: json_str(body, "fileType"),
        size_bytes: body.get("sizeBytes").and_then(|v| v.as_u64()),
        category: json_str(body, "category"),
        queue_id: json_str(body, "queueId"),
        connections: body
            .get("connections")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32),
        resumable: body.get("resumable").and_then(|v| v.as_bool()),
        save_path: json_str(body, "savePath"),
        description: json_str(body, "description"),
        referer: json_str(body, "referer"),
        start_immediately: Some(start_immediately),
        direct_options: body
            .get("directOptions")
            .and_then(|v| v.as_object())
            .map(|map| map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
        media_options: None,
    })
}

pub async fn handle_v1_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let download_body = match legacy_v1_body_to_download_body(&body, true) {
        Ok(v) => v,
        Err(message) => {
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": message}),
            );
        }
    };
    if let Some(ref url) = download_body.url {
        if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
            log::warn!("Blocked SSRF in v1/add for {}: {}", url, e);
            return Json(
                serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": e}),
            );
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
                "message": e
            }))
        }
    }
}

pub async fn handle_v1_stream_resolve(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let manifest_type = body
        .get("manifestType")
        .and_then(|v| v.as_str())
        .unwrap_or("hls");
    if url.is_empty() {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Missing url", "qualities": []}),
        );
    }
    if url.starts_with('-') {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Invalid url", "qualities": []}),
        );
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Only http(s) stream manifests are supported", "qualities": []}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked stream resolve of unsafe URL {}: {}", url, e);
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": e, "qualities": []}),
        );
    }

    let ytdlp_bin = state.ytdlp_bin.clone();
    let url2 = url.to_string();
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(move || {
            hidden_output(
                &ytdlp_bin,
                &[
                    "--dump-json",
                    "--no-playlist",
                    "--no-warnings",
                    "--skip-download",
                    "--",
                    &url2,
                ],
            )
        }),
    )
    .await;

    let Ok(joined) = output else {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": "Stream resolve timed out", "qualities": []}),
        );
    };
    let spawned = match joined {
        Ok(value) => value,
        Err(error) => {
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": format!("Stream resolve worker failed: {}", error), "qualities": []}),
            );
        }
    };
    let process_output = match spawned {
        Ok(value) => value,
        Err(error) => {
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": format!("yt-dlp failed to start: {}", error), "qualities": []}),
            );
        }
    };
    if !process_output.status.success() {
        return Json(
            serde_json::json!({"ok": false, "resolved": false, "message": String::from_utf8_lossy(&process_output.stderr).lines().next().unwrap_or("yt-dlp could not resolve this stream"), "qualities": []}),
        );
    }
    let stdout = String::from_utf8_lossy(&process_output.stdout);
    let info: serde_json::Value = match serde_json::from_str(&stdout) {
        Ok(value) => value,
        Err(_) => {
            return Json(
                serde_json::json!({"ok": false, "resolved": false, "message": "Could not parse yt-dlp stream metadata", "qualities": []}),
            )
        }
    };
    let mut qualities = Vec::new();
    if let Some(formats) = info.get("formats").and_then(|v| v.as_array()) {
        for format in formats {
            let Some(format_url) = format.get("url").and_then(|v| v.as_str()) else {
                continue;
            };
            let height = format
                .get("height")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let width = format
                .get("width")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            let bandwidth = format
                .get("tbr")
                .and_then(|v| v.as_f64())
                .map(|v| (v * 1000.0).max(0.0) as u64)
                .or_else(|| {
                    format
                        .get("abr")
                        .and_then(|v| v.as_f64())
                        .map(|v| (v * 1000.0).max(0.0) as u64)
                });
            let label = format
                .get("format_note")
                .or_else(|| format.get("resolution"))
                .or_else(|| format.get("format_id"))
                .and_then(|v| v.as_str())
                .map(|v| v.to_string())
                .or_else(|| height.map(|h| format!("{}p", h)));
            let mut q = serde_json::Map::new();
            q.insert("url".to_string(), serde_json::json!(format_url));
            if let Some(width) = width {
                q.insert("width".to_string(), serde_json::json!(width));
            }
            if let Some(height) = height {
                q.insert("height".to_string(), serde_json::json!(height));
            }
            if let Some(bandwidth) = bandwidth {
                q.insert("bandwidth".to_string(), serde_json::json!(bandwidth));
            }
            if let Some(codecs) = format
                .get("vcodec")
                .or_else(|| format.get("acodec"))
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty() && *v != "none")
            {
                q.insert("codecs".to_string(), serde_json::json!(codecs));
            }
            if let Some(label) = label.filter(|v| !v.is_empty()) {
                q.insert("label".to_string(), serde_json::json!(label));
            }
            if let Some(format_id) = format
                .get("format_id")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("formatId".to_string(), serde_json::json!(format_id));
            }
            if let Some(container) = format
                .get("ext")
                .and_then(|v| v.as_str())
                .filter(|v| !v.is_empty())
            {
                q.insert("container".to_string(), serde_json::json!(container));
            }
            if let Some(fps) = format
                .get("fps")
                .and_then(|v| v.as_f64())
                .filter(|v| *v > 0.0)
            {
                q.insert("fps".to_string(), serde_json::json!(fps));
            }
            q.insert(
                "hasVideo".to_string(),
                serde_json::json!(format
                    .get("vcodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            q.insert(
                "hasAudio".to_string(),
                serde_json::json!(format
                    .get("acodec")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| v != "none")),
            );
            qualities.push(serde_json::Value::Object(q));
        }
    }
    qualities.sort_by(|a, b| {
        let ah = a.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        let bh = b.get("height").and_then(|v| v.as_u64()).unwrap_or(0);
        bh.cmp(&ah)
    });
    qualities.dedup_by(|a, b| a.get("url") == b.get("url"));

    let mut payload = serde_json::Map::new();
    payload.insert("ok".to_string(), serde_json::json!(true));
    payload.insert("resolved".to_string(), serde_json::json!(true));
    payload.insert("manifestType".to_string(), serde_json::json!(manifest_type));
    payload.insert("qualities".to_string(), serde_json::Value::Array(qualities));
    if let Some(duration) = info
        .get("duration")
        .and_then(|v| v.as_f64())
        .filter(|v| *v >= 0.0)
    {
        payload.insert("durationSec".to_string(), serde_json::json!(duration));
    }
    if let Some(is_live) = info.get("is_live").and_then(|v| v.as_bool()) {
        payload.insert("isLive".to_string(), serde_json::json!(is_live));
    }
    payload.insert("drmProtected".to_string(), serde_json::json!(false));
    payload.insert("subtitleTracks".to_string(), serde_json::json!([]));
    payload.insert("audioTracks".to_string(), serde_json::json!([]));
    if let Some(size) = info
        .get("filesize")
        .or_else(|| info.get("filesize_approx"))
        .and_then(|v| v.as_u64())
    {
        payload.insert("estimatedSizeBytes".to_string(), serde_json::json!(size));
    }
    Json(serde_json::Value::Object(payload))
}

pub async fn handle_v1_stream_add(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let manifest = body.get("manifest").unwrap_or(&body);
    if manifest
        .get("drmProtected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "DRM-protected streams cannot be downloaded."}),
        );
    }
    let selected = body.get("selectedQuality");
    let manifest_url = manifest
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let selected_url = selected
        .and_then(|q| q.get("url"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let url = if !manifest_url.is_empty() {
        manifest_url
    } else {
        selected_url
    };
    if url.is_empty() || url.starts_with('-') {
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": "Invalid stream URL"}),
        );
    }
    if let Err(e) = crate::daemon::utils::is_safe_target_url(url) {
        log::warn!("Blocked SSRF in stream/add for {}: {}", url, e);
        return Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": e}),
        );
    }
    let mut media_options = crate::daemon::types::MediaDownloadOptions {
        mode: Some("video".to_string()),
        playlist: Some(false),
        ffmpeg_enabled: Some(true),
        embed_metadata: Some(true),
        concurrent_fragments: Some(8),
        retries: Some(5),
        fragment_retries: Some(10),
        referer: manifest
            .get("referrer")
            .or_else(|| manifest.get("pageUrl"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        ..Default::default()
    };
    if let Some(format_id) = selected
        .and_then(|q| q.get("formatId"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
    {
        media_options.format_selector = Some(format_id.to_string());
    } else if let Some(height) = selected
        .and_then(|q| q.get("height"))
        .and_then(|v| v.as_u64())
    {
        media_options.quality = Some(format!("{}p", height));
        media_options.format_selector = Some(format!(
            "bestvideo[height<={0}]+bestaudio/best[height<={0}]/best",
            height
        ));
    }
    let body = CreateDownloadBody {
        url: Some(url.to_string()),
        name: manifest
            .get("title")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string())
            .or_else(|| Some("stream".to_string())),
        file_type: Some("video".to_string()),
        size_bytes: selected
            .and_then(|q| q.get("estimatedSizeBytes"))
            .and_then(|v| v.as_u64()),
        category: Some("video".to_string()),
        queue_id: None,
        connections: Some(1),
        resumable: Some(true),
        save_path: None,
        description: Some("Browser extension HLS/DASH stream via yt-dlp + FFmpeg".to_string()),
        referer: media_options.referer.clone(),
        start_immediately: Some(true),
        direct_options: None,
        media_options: Some(media_options),
    };
    match create_ytdlp_task(&state, &body).await {
        Ok(task) => Json(
            serde_json::json!({"ok": true, "accepted": true, "taskId": task.id, "taskIds": [task.id], "message": "Stream added"}),
        ),
        Err(error) => Json(
            serde_json::json!({"ok": false, "accepted": false, "taskId": "", "taskIds": [], "message": error}),
        ),
    }
}

// ─── Engine: Event Bus ───────────────────────────────────────────────

pub async fn handle_engine_events(
    State(state): State<SharedState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let count = params
        .get("count")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(100);
    let events = state.event_bus.recent_events(count);
    let serialized: Vec<serde_json::Value> = events
        .into_iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id,
                "event": e.event,
                "timestamp_millis": e.timestamp_millis,
                "age_secs": e.timestamp.elapsed().as_secs(),
            })
        })
        .collect();
    Json(serde_json::json!({
        "ok": true,
        "events": serialized,
        "subscribers": state.event_bus.subscriber_count(),
    }))
}

pub async fn handle_engine_events_clear(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    state.event_bus.clear_log();
    Json(serde_json::json!({"ok": true}))
}

pub async fn handle_engine_events_for_task(
    State(state): State<SharedState>,
    Path(task_id): Path<String>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let count = params
        .get("count")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(50);
    let events = state.event_bus.events_for_task(&task_id, count);
    let serialized: Vec<serde_json::Value> = events
        .into_iter()
        .map(|e| serde_json::json!({"id": e.id, "event": e.event, "timestamp_millis": e.timestamp_millis}))
        .collect();
    Json(serde_json::json!({"ok": true, "task_id": task_id, "events": serialized}))
}

// ─── Engine: Priority Queue ─────────────────────────────────────────

pub async fn handle_queue_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let entries = state.priority_queue.entries();
    Json(serde_json::json!({
        "ok": true,
        "entries": entries,
        "active_count": state.priority_queue.active_count(),
        "total_bandwidth_kbps": state.priority_queue.total_bandwidth(),
        "next_to_start": state.priority_queue.next_to_start(),
    }))
}

#[derive(Deserialize)]
pub struct QueueSetPriorityBody {
    task_id: String,
    priority: u32,
}

pub async fn handle_queue_set_priority(
    State(state): State<SharedState>,
    Json(body): Json<QueueSetPriorityBody>,
) -> Json<serde_json::Value> {
    let priority = DownloadPriority::from_u32(body.priority);
    state.priority_queue.set_priority(&body.task_id, priority);
    state.event_bus.publish(
        crate::daemon::engine::event_bus::EngineEvent::QueueChanged {
            task_id: body.task_id.clone(),
            position: 0,
            priority: body.priority,
        },
    );
    Json(
        serde_json::json!({"ok": true, "task_id": body.task_id, "priority": format!("{:?}", priority)}),
    )
}

// ─── Engine: Bandwidth Manager ──────────────────────────────────────

pub async fn handle_bandwidth_get(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let task_stats: Vec<serde_json::Value> = {
        let tasks = lock_or_err!(
            state.task_snapshot,
            Json(serde_json::json!({"ok": false, "error": "lock poisoned"}))
        );
        tasks
            .values()
            .filter(|t| t.status == "downloading")
            .map(|t| {
                serde_json::json!({
                    "task_id": t.id,
                    "average_speed_bps": state.bandwidth_manager.average_speed(&t.id),
                    "allowed_kbps": state.bandwidth_manager.allowed_speed_for_task(&t.id),
                })
            })
            .collect()
    };
    Json(serde_json::json!({
        "ok": true,
        "global_limit_kbps": state.bandwidth_manager.effective_global_limit(),
        "paused": state.bandwidth_manager.is_paused(),
        "tasks": task_stats,
    }))
}

#[derive(Deserialize)]
pub struct BandwidthSetBody {
    global_limit_kbps: Option<u64>,
    paused: Option<bool>,
    task_limits: Option<HashMap<String, u64>>,
    remove_task_limits: Option<Vec<String>>,
    schedule_limits: Option<Vec<ScheduleLimit>>,
}

pub async fn handle_bandwidth_set(
    State(state): State<SharedState>,
    Json(body): Json<BandwidthSetBody>,
) -> Json<serde_json::Value> {
    if let Some(limit) = body.global_limit_kbps {
        state.bandwidth_manager.set_global_limit(limit);
        state.priority_queue.set_total_bandwidth(limit);
    }
    if let Some(limits) = body.task_limits {
        for (task_id, kbps) in limits {
            state
                .bandwidth_manager
                .set_task_limit(task_id.clone(), kbps);
        }
    }
    if let Some(task_ids) = body.remove_task_limits {
        for task_id in task_ids {
            state.bandwidth_manager.remove_task_limit(&task_id);
        }
    }
    if let Some(schedules) = body.schedule_limits {
        state.bandwidth_manager.set_schedule_limits(schedules);
    }
    if let Some(paused) = body.paused {
        if paused {
            state.bandwidth_manager.pause_all();
        } else {
            state.bandwidth_manager.resume_all();
        }
    }
    Json(serde_json::json!({
        "ok": true,
        "global_limit_kbps": state.bandwidth_manager.effective_global_limit(),
        "paused": state.bandwidth_manager.is_paused(),
    }))
}

// ─── Engine: Rate Limiter ───────────────────────────────────────────

pub async fn handle_rate_limit_get(State(state): State<SharedState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "paused": state.bandwidth_manager.is_paused(),
        "global_limit_kbps": state.bandwidth_manager.effective_global_limit(),
    }))
}

#[derive(Deserialize)]
pub struct RateLimitSetBody {
    global_limit_kbps: Option<u64>,
    task_limit: Option<HashMap<String, u64>>,
    remove_task_limits: Option<Vec<String>>,
}

pub async fn handle_rate_limit_set(
    State(state): State<SharedState>,
    Json(body): Json<RateLimitSetBody>,
) -> Json<serde_json::Value> {
    if let Some(limit) = body.global_limit_kbps {
        state.bandwidth_manager.set_global_limit(limit);
    }
    if let Some(limits) = body.task_limit {
        for (task_id, kbps) in limits {
            state.bandwidth_manager.set_task_limit(task_id, kbps);
        }
    }
    if let Some(task_ids) = body.remove_task_limits {
        for task_id in task_ids {
            state.bandwidth_manager.remove_task_limit(&task_id);
        }
    }
    Json(serde_json::json!({"ok": true}))
}

// ─── Engine: Download Profiles ──────────────────────────────────────

pub async fn handle_profiles_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let profiles = state.profile_manager.list_profiles();
    let active = state.profile_manager.active_profile();
    Json(serde_json::json!({
        "ok": true,
        "profiles": profiles,
        "active_profile": active.id,
    }))
}

#[derive(Deserialize)]
pub struct ProfileSetActiveBody {
    profile_id: String,
}

pub async fn handle_profiles_set_active(
    State(state): State<SharedState>,
    Json(body): Json<ProfileSetActiveBody>,
) -> Json<serde_json::Value> {
    let success = state.profile_manager.set_active(&body.profile_id);
    if success {
        let profile = state.profile_manager.active_profile();
        // Applying a profile updates the engine-wide retry policy and, when
        // the profile declares one, the global rate limit.
        if let Ok(mut policy) = state.default_retry_policy.write() {
            *policy = profile.to_retry_policy();
        }
        if let Some(kbps) = profile.rate_limit_kbps {
            state.bandwidth_manager.set_global_limit(kbps);
            state.priority_queue.set_total_bandwidth(kbps);
        }
        state.event_bus.publish(
            crate::daemon::engine::event_bus::EngineEvent::ProfileSwitched {
                task_id: "global".to_string(),
                profile: profile.name,
            },
        );
    }
    Json(serde_json::json!({"ok": success, "profile_id": body.profile_id}))
}

fn retry_policy_json(policy: &RetryPolicy) -> serde_json::Value {
    serde_json::json!({
        "max_retries": policy.max_retries,
        "base_delay_secs": policy.base_delay.as_secs_f64(),
        "max_delay_secs": policy.max_delay.as_secs_f64(),
        "backoff_multiplier": policy.backoff_multiplier,
        "jitter": policy.jitter,
    })
}

pub async fn handle_profiles_get(
    State(state): State<SharedState>,
    Path(profile_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.profile_manager.get_profile(&profile_id) {
        Some(profile) => {
            let adaptive = profile.to_adaptive_config();
            let retry = profile.to_retry_policy();
            Json(serde_json::json!({
                "ok": true,
                "profile": profile,
                "resolved": {
                    "adaptive": {
                        "min_connections": adaptive.min_connections,
                        "max_connections": adaptive.max_connections,
                        "speed_high_threshold_bps": adaptive.speed_high_threshold,
                        "speed_low_threshold_bps": adaptive.speed_low_threshold,
                        "stall_threshold_ms": adaptive.stall_threshold.as_millis(),
                        "eval_interval_ms": adaptive.eval_interval.as_millis(),
                    },
                    "retry": retry_policy_json(&retry),
                },
            }))
        }
        None => Json(serde_json::json!({"ok": false, "error": "Profile not found"})),
    }
}

pub async fn handle_profiles_add_custom(
    State(state): State<SharedState>,
    Json(profile): Json<crate::daemon::engine::profiles::DownloadProfile>,
) -> Json<serde_json::Value> {
    if profile.id.trim().is_empty() {
        return Json(serde_json::json!({"ok": false, "error": "Profile id is required"}));
    }
    let profile_id = profile.id.clone();
    state.profile_manager.add_profile(profile);
    Json(serde_json::json!({"ok": true, "profile_id": profile_id}))
}

const BUILTIN_PROFILE_IDS: [&str; 4] = ["maximum-speed", "balanced", "economical", "background"];

pub async fn handle_profiles_delete(
    State(state): State<SharedState>,
    Path(profile_id): Path<String>,
) -> Json<serde_json::Value> {
    if BUILTIN_PROFILE_IDS.contains(&profile_id.as_str()) {
        return Json(
            serde_json::json!({"ok": false, "error": "Built-in profiles cannot be removed"}),
        );
    }
    let removed = state.profile_manager.remove_profile(&profile_id);
    Json(serde_json::json!({"ok": removed, "profile_id": profile_id}))
}

// ─── Engine: Retry Policy ───────────────────────────────────────────

pub async fn handle_retry_policy_get(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let policy = state
        .default_retry_policy
        .read()
        .map(|p| p.clone())
        .unwrap_or_default();
    let backoff_preview: Vec<f64> = (1..=policy.max_retries.min(5))
        .map(|attempt| policy.delay_for_attempt(attempt).as_secs_f64())
        .collect();
    Json(serde_json::json!({
        "ok": true,
        "policy": retry_policy_json(&policy),
        "backoff_preview_secs": backoff_preview,
    }))
}

#[derive(Deserialize)]
pub struct RetryPolicySetBody {
    preset: Option<String>,
    max_retries: Option<u32>,
    base_delay_secs: Option<u64>,
    max_delay_secs: Option<u64>,
    backoff_multiplier: Option<f64>,
    jitter: Option<bool>,
}

pub async fn handle_retry_policy_set(
    State(state): State<SharedState>,
    Json(body): Json<RetryPolicySetBody>,
) -> Json<serde_json::Value> {
    let mut policy = match body.preset.as_deref() {
        Some("aggressive") => RetryPolicy::aggressive(),
        Some("conservative") => RetryPolicy::conservative(),
        Some("none") => RetryPolicy::no_retry(),
        Some("default") | None => RetryPolicy::default(),
        Some(other) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown preset '{}'; use default|aggressive|conservative|none", other),
            }));
        }
    };
    if let Some(max_retries) = body.max_retries {
        policy.max_retries = max_retries.min(100);
    }
    if let Some(secs) = body.base_delay_secs {
        policy.base_delay = Duration::from_secs(secs.min(3600));
    }
    if let Some(secs) = body.max_delay_secs {
        policy.max_delay = Duration::from_secs(secs.min(86_400));
    }
    if let Some(multiplier) = body.backoff_multiplier {
        policy.backoff_multiplier = multiplier.clamp(1.0, 10.0);
    }
    if let Some(jitter) = body.jitter {
        policy.jitter = jitter;
    }
    let response = retry_policy_json(&policy);
    if let Ok(mut current) = state.default_retry_policy.write() {
        *current = policy;
    }
    Json(serde_json::json!({"ok": true, "policy": response}))
}

// ─── Engine: Download Rules ─────────────────────────────────────────

pub async fn handle_rules_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let rules = state.rule_engine.rules();
    Json(serde_json::json!({"ok": true, "rules": rules}))
}

#[derive(Deserialize)]
pub struct RuleAddBody {
    rule: DownloadRule,
}

pub async fn handle_rules_add(
    State(state): State<SharedState>,
    Json(body): Json<RuleAddBody>,
) -> Json<serde_json::Value> {
    let rule_id = body.rule.id.clone();
    state.rule_engine.add_rule(body.rule);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

pub async fn handle_rules_delete(
    State(state): State<SharedState>,
    Path(rule_id): Path<String>,
) -> Json<serde_json::Value> {
    state.rule_engine.remove_rule(&rule_id);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

// ─── Engine: Smart Scheduler ────────────────────────────────────────

pub async fn handle_scheduler_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let rules = state.scheduler.rules();
    let active_ids = state.scheduler.active_rule_ids();
    Json(serde_json::json!({"ok": true, "rules": rules, "active_rule_ids": active_ids}))
}

#[derive(Deserialize)]
pub struct SchedulerAddBody {
    rule: SchedulerRule,
}

pub async fn handle_scheduler_add(
    State(state): State<SharedState>,
    Json(body): Json<SchedulerAddBody>,
) -> Json<serde_json::Value> {
    let rule_id = body.rule.id.clone();
    state.scheduler.add_rule(body.rule);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

pub async fn handle_scheduler_delete(
    State(state): State<SharedState>,
    Path(rule_id): Path<String>,
) -> Json<serde_json::Value> {
    state.scheduler.remove_rule(&rule_id);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

pub async fn handle_scheduler_update(
    State(state): State<SharedState>,
    Json(body): Json<SchedulerAddBody>,
) -> Json<serde_json::Value> {
    let rule_id = body.rule.id.clone();
    state.scheduler.update_rule(body.rule);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

/// Periodic scheduler tick: evaluate all rules and apply triggered actions.
pub async fn run_scheduler_tick(state: &SharedState) {
    let active_count = {
        let jobs = lock_or_err!(state.curl_jobs);
        jobs.values()
            .filter(|j| j.task.status == "downloading" || j.task.status == "active")
            .count() as u32
    };
    let current_bw = state.bandwidth_manager.effective_global_limit();
    let actions = state.scheduler.evaluate(current_bw, active_count);
    for action in actions {
        match action {
            SchedulerAction::StartDownload { task_ids } => {
                for tid in &task_ids {
                    log::info!("Scheduler: resuming task {}", tid);
                    let _ = crate::daemon::curl::resume_task(state, tid).await;
                }
            }
            SchedulerAction::PauseDownload { task_ids } => {
                for tid in &task_ids {
                    log::info!("Scheduler: pausing task {}", tid);
                    let _ = crate::daemon::curl::pause_task(state, tid).await;
                }
            }
            SchedulerAction::SetBandwidthLimit { kbps } => {
                log::info!("Scheduler: setting global bandwidth limit to {} kbps", kbps);
                state.bandwidth_manager.set_global_limit(kbps);
            }
            SchedulerAction::SetPriority { task_ids, priority } => {
                log::info!(
                    "Scheduler: setting priority for {} tasks to {}",
                    task_ids.len(),
                    priority
                );
            }
            SchedulerAction::Notify { message } => {
                log::info!("Scheduler notification: {}", message);
                crate::daemon::telegram::telegram_notify(state, &message).await;
            }
        }
    }
}

// ─── Engine: Checksum Verification ──────────────────────────────────

#[derive(Deserialize)]
pub struct ChecksumVerifyBody {
    path: String,
    expected: String,
    algorithm: Option<String>,
}

pub async fn handle_checksum_verify(
    State(state): State<SharedState>,
    Json(body): Json<ChecksumVerifyBody>,
) -> Json<serde_json::Value> {
    let path = std::path::Path::new(&body.path);
    match path.canonicalize() {
        Ok(canonical) => {
            let data_dir = std::path::Path::new(&state.data_dir)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(&state.data_dir));
            if !canonical.starts_with(&data_dir) {
                return Json(
                    serde_json::json!({"ok": false, "error": "Path outside data directory"}),
                );
            }
        }
        Err(_) => {
            return Json(serde_json::json!({"ok": false, "error": "File not found"}));
        }
    }
    if !path.exists() {
        return Json(serde_json::json!({"ok": false, "error": "File not found"}));
    }
    let result = if let Some(algo_name) = &body.algorithm {
        if let Some(algo) = ChecksumAlgorithm::from_name(algo_name) {
            let expected = body.expected.trim();
            if expected.len() != algo.hex_length() {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!(
                        "{} digests are {} hex characters; got {}",
                        algo.name(),
                        algo.hex_length(),
                        expected.len()
                    ),
                }));
            }
            Some(checksum::verify_checksum(path, &algo, expected))
        } else {
            None
        }
    } else {
        checksum::auto_verify(path, &body.expected)
    };
    match result {
        Some(r) => Json(serde_json::json!({
            "ok": true,
            "algorithm": r.algorithm.name(),
            "expected": r.expected,
            "actual": r.actual,
            "passed": r.passed,
        })),
        None => Json(
            serde_json::json!({"ok": false, "error": "Could not determine algorithm or verify checksum"}),
        ),
    }
}

// ─── Engine: Mirror Download ────────────────────────────────────────

pub async fn handle_mirrors_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let managers = lock_or_err!(state.mirror_managers);
    let mirror_data: Vec<serde_json::Value> = managers
        .iter()
        .map(|(task_id, mgr)| {
            let sources = mgr.mirrors();
            let active = mgr.active_url();
            serde_json::json!({
                "task_id": task_id,
                "active_url": active,
                "mirrors": sources.iter().map(|s| serde_json::json!({
                    "url": s.url,
                    "priority": s.priority,
                    "healthy": s.healthy,
                    "region": s.region,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(serde_json::json!({"ok": true, "downloads": mirror_data}))
}

#[derive(Deserialize)]
pub struct MirrorAddBody {
    task_id: String,
    mirror_url: String,
    priority: Option<u32>,
}

pub async fn handle_mirrors_add(
    State(state): State<SharedState>,
    Json(body): Json<MirrorAddBody>,
) -> Json<serde_json::Value> {
    {
        let mut managers = lock_or_err!(state.mirror_managers);
        let manager = managers
            .entry(body.task_id.clone())
            .or_insert_with(|| MirrorManager::new(&body.task_id));
        manager.add_mirror(MirrorSource {
            url: body.mirror_url.clone(),
            priority: body.priority.unwrap_or(0),
            region: None,
            bandwidth_estimate: None,
            last_checked: None,
            healthy: true,
        });
    }
    state
        .event_bus
        .publish(crate::daemon::engine::event_bus::EngineEvent::MirrorFound {
            task_id: body.task_id.clone(),
            mirror_url: body.mirror_url,
        });
    Json(serde_json::json!({"ok": true, "task_id": body.task_id}))
}

// ─── Plugin API ─────────────────────────────────────────────────────

pub async fn handle_plugins_list(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let plugins = state.plugin_api.list_plugins();
    Json(serde_json::json!({
        "ok": true,
        "plugins": plugins,
        "api_version": state.plugin_api.api_version(),
    }))
}

pub async fn handle_plugins_get(
    State(state): State<SharedState>,
    Path(plugin_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.plugin_api.get_plugin(&plugin_id) {
        Some(info) => Json(serde_json::json!({"ok": true, "plugin": info})),
        None => Json(serde_json::json!({"ok": false, "error": "Plugin not found"})),
    }
}

#[derive(Deserialize)]
pub struct PluginRegisterBody {
    manifest: PluginManifest,
}

pub async fn handle_plugins_register(
    State(state): State<SharedState>,
    Json(body): Json<PluginRegisterBody>,
) -> Json<serde_json::Value> {
    match state.plugin_api.register_plugin(body.manifest.clone()) {
        Ok(()) => Json(serde_json::json!({"ok": true, "plugin_id": body.manifest.id})),
        Err(e) => Json(serde_json::json!({"ok": false, "error": e})),
    }
}

pub async fn handle_plugins_unregister(
    State(state): State<SharedState>,
    Path(plugin_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.plugin_api.unregister_plugin(&plugin_id) {
        Ok(()) => Json(serde_json::json!({"ok": true, "plugin_id": plugin_id})),
        Err(e) => Json(serde_json::json!({"ok": false, "error": e})),
    }
}

pub async fn handle_plugins_enable(
    State(state): State<SharedState>,
    Path(plugin_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.plugin_api.enable_plugin(&plugin_id) {
        Ok(()) => Json(serde_json::json!({"ok": true, "plugin_id": plugin_id})),
        Err(e) => Json(serde_json::json!({"ok": false, "error": e})),
    }
}

pub async fn handle_plugins_disable(
    State(state): State<SharedState>,
    Path(plugin_id): Path<String>,
) -> Json<serde_json::Value> {
    match state.plugin_api.disable_plugin(&plugin_id) {
        Ok(()) => Json(serde_json::json!({"ok": true, "plugin_id": plugin_id})),
        Err(e) => Json(serde_json::json!({"ok": false, "error": e})),
    }
}

#[derive(Deserialize)]
pub struct PluginSettingsBody {
    settings: HashMap<String, serde_json::Value>,
}

pub async fn handle_plugins_update_settings(
    State(state): State<SharedState>,
    Path(plugin_id): Path<String>,
    Json(body): Json<PluginSettingsBody>,
) -> Json<serde_json::Value> {
    match state
        .plugin_api
        .update_plugin_settings(&plugin_id, body.settings)
    {
        Ok(()) => Json(serde_json::json!({"ok": true, "plugin_id": plugin_id})),
        Err(e) => Json(serde_json::json!({"ok": false, "error": e})),
    }
}

// ─── Engine: Adaptive Connections ─────────────────────────────────

pub async fn handle_adaptive_get(
    State(state): State<SharedState>,
    Path(task_id): Path<String>,
) -> Json<serde_json::Value> {
    let trackers = lock_or_err!(state.engine_trackers);
    match trackers.get(&task_id) {
        Some(tracker) => {
            let adaptive = &tracker.adaptive;
            let retry = &tracker.retry_state;
            Json(serde_json::json!({
                "ok": true,
                "task_id": task_id,
                "connections": adaptive.connections(),
                "max_connections": adaptive.max_connections.load(std::sync::atomic::Ordering::Relaxed),
                "speed": adaptive.speed(),
                "peak_speed": adaptive.peak_speed(),
                "retry_state": {
                    "total_retries": retry.total_retries,
                    "last_error": retry.last_error,
                },
            }))
        }
        None => Json(serde_json::json!({"ok": false, "error": "no tracker for task"})),
    }
}

// ─── Engine: Dynamic Segments ─────────────────────────────────────

pub async fn handle_segments_get(
    State(state): State<SharedState>,
    Path(task_id): Path<String>,
) -> Json<serde_json::Value> {
    let trackers = lock_or_err!(state.engine_trackers);
    match trackers.get(&task_id) {
        Some(tracker) => match &tracker.segments {
            Some(segments) => {
                let segs = segments.segments();
                let total = segs.len();
                let completed = segs
                    .iter()
                    .filter(|s| s.downloaded >= s.total_bytes)
                    .count();
                Json(serde_json::json!({
                    "ok": true,
                    "task_id": task_id,
                    "total_segments": total,
                    "completed_segments": completed,
                    "progress": segments.total_progress(),
                }))
            }
            None => Json(serde_json::json!({"ok": true, "task_id": task_id, "segmented": false})),
        },
        None => Json(serde_json::json!({"ok": false, "error": "no tracker for task"})),
    }
}

// ─── Engine: Metadata Cache ───────────────────────────────────────

pub async fn handle_metadata_cache_stats(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let entries = state.metadata_cache.size();
    Json(serde_json::json!({
        "ok": true,
        "entries": entries,
    }))
}

pub async fn handle_metadata_cache_clear(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    state.metadata_cache.clear();
    Json(serde_json::json!({"ok": true}))
}

// ─── Engine: Mirrors ──────────────────────────────────────────────

#[derive(Deserialize)]
pub struct MirrorSetBody {
    task_id: String,
    mirror_url: String,
}

pub async fn handle_mirrors_set(
    State(state): State<SharedState>,
    Json(body): Json<MirrorSetBody>,
) -> Json<serde_json::Value> {
    let mut managers = lock_or_err!(state.mirror_managers);
    let manager = managers
        .entry(body.task_id.clone())
        .or_insert_with(|| MirrorManager::new(&body.mirror_url));
    manager.set_mirrors(vec![MirrorSource {
        url: body.mirror_url.clone(),
        priority: 0,
        region: None,
        bandwidth_estimate: None,
        last_checked: None,
        healthy: true,
    }]);
    Json(serde_json::json!({"ok": true, "task_id": body.task_id, "mirror_url": body.mirror_url}))
}

#[derive(Deserialize)]
pub struct MirrorFailoverBody {
    task_id: String,
}

pub async fn handle_mirrors_failover(
    State(state): State<SharedState>,
    Json(body): Json<MirrorFailoverBody>,
) -> Json<serde_json::Value> {
    let mut managers = lock_or_err!(state.mirror_managers);
    if let Some(manager) = managers.get_mut(&body.task_id) {
        let url = manager.active_url();
        Json(serde_json::json!({
            "ok": true,
            "task_id": body.task_id,
            "active_url": url,
        }))
    } else {
        Json(serde_json::json!({"ok": false, "error": "no mirror manager for task"}))
    }
}

#[derive(Deserialize)]
pub struct MirrorFailoverControlBody {
    task_id: String,
    enabled: bool,
}

pub async fn handle_mirrors_enable_failover(
    State(state): State<SharedState>,
    Json(body): Json<MirrorFailoverControlBody>,
) -> Json<serde_json::Value> {
    let managers = lock_or_err!(state.mirror_managers);
    if let Some(manager) = managers.get(&body.task_id) {
        if body.enabled {
            manager.enable_failover();
        } else {
            manager.disable_failover();
        }
        Json(
            serde_json::json!({"ok": true, "task_id": body.task_id, "failover_enabled": body.enabled}),
        )
    } else {
        Json(serde_json::json!({"ok": false, "error": "no mirror manager for task"}))
    }
}
