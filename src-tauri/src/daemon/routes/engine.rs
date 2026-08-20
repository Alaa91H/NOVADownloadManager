use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::{delete, get, post};
use axum::Router;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

use crate::daemon::engine::bandwidth::ScheduleLimit;
use crate::daemon::engine::checksum::{self, ChecksumAlgorithm};
use crate::daemon::engine::mirror::{MirrorManager, MirrorSource};
use crate::daemon::engine::plugin_api::PluginManifest;
use crate::daemon::engine::priority_queue::DownloadPriority;
use crate::daemon::engine::retry::RetryPolicy;
use crate::daemon::engine::rules::DownloadRule;
use crate::daemon::engine::scheduler::{SchedulerAction, SchedulerRule};
use crate::daemon::state::SharedState;
use crate::daemon::utils::hide_command_window;
use crate::lock_or_err;

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
            "extractors".to_owned(),
            serde_json::Value::Array(extractors),
        );
    }
    Json(status)
}

pub(super) fn bool_from_status(status: &serde_json::Value, pointer: &str) -> bool {
    status
        .pointer(pointer)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

pub(super) fn extension_capabilities_from_status(status: &serde_json::Value) -> serde_json::Value {
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
    items.push("media.analyze");
    items.sort_unstable();
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

pub async fn handle_engine_events(
    State(state): State<SharedState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let count = params
        .get("count")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(100)
        .min(1000);
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
        .unwrap_or(50)
        .min(1000);
    let events = state.event_bus.events_for_task(&task_id, count);
    let serialized: Vec<serde_json::Value> = events
        .into_iter()
        .map(|e| serde_json::json!({"id": e.id, "event": e.event, "timestamp_millis": e.timestamp_millis}))
        .collect();
    Json(serde_json::json!({"ok": true, "task_id": task_id, "events": serialized}))
}

// â”€â”€â”€ Engine: Priority Queue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Engine: Bandwidth Manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn handle_bandwidth_get(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let task_stats: Vec<serde_json::Value> = {
        let tasks = lock_or_err!(state.task_snapshot);
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

// â”€â”€â”€ Engine: Rate Limiter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Engine: Download Profiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        // Applying a profile replaces the engine-wide retry policy and rate
        // limit as one coherent setting. A profile without a limit explicitly
        // restores unlimited bandwidth (0); otherwise switching from
        // economical/background to balanced would leave the old cap active.
        if let Ok(mut policy) = state.default_retry_policy.write() {
            *policy = profile.to_retry_policy();
        }
        let kbps = profile.rate_limit_kbps.unwrap_or(0);
        state.bandwidth_manager.set_global_limit(kbps);
        state.priority_queue.set_total_bandwidth(kbps);
        state.event_bus.publish(
            crate::daemon::engine::event_bus::EngineEvent::ProfileSwitched {
                task_id: "global".to_owned(),
                profile: profile.name,
            },
        );
    }
    Json(serde_json::json!({"ok": success, "profile_id": body.profile_id}))
}

pub(super) fn retry_policy_json(policy: &RetryPolicy) -> serde_json::Value {
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
    if !state.profile_manager.add_profile(profile) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "Built-in profile ids are reserved or the profile store is unavailable"
        }));
    }
    Json(serde_json::json!({"ok": true, "profile_id": profile_id}))
}

pub async fn handle_profiles_delete(
    State(state): State<SharedState>,
    Path(profile_id): Path<String>,
) -> Json<serde_json::Value> {
    if crate::daemon::engine::profiles::DownloadProfile::is_builtin_id(&profile_id) {
        return Json(
            serde_json::json!({"ok": false, "error": "Built-in profiles cannot be removed"}),
        );
    }
    let removed = state.profile_manager.remove_profile(&profile_id);
    Json(serde_json::json!({"ok": removed, "profile_id": profile_id}))
}

// â”€â”€â”€ Engine: Retry Policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Engine: Download Rules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    match state.rule_engine.try_add_rule(body.rule) {
        Ok(()) => Json(serde_json::json!({"ok": true, "rule_id": rule_id})),
        Err(error) => Json(serde_json::json!({"ok": false, "error": error})),
    }
}

pub async fn handle_rules_delete(
    State(state): State<SharedState>,
    Path(rule_id): Path<String>,
) -> Json<serde_json::Value> {
    state.rule_engine.remove_rule(&rule_id);
    Json(serde_json::json!({"ok": true, "rule_id": rule_id}))
}

// â”€â”€â”€ Engine: Smart Scheduler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

#[derive(Deserialize)]
pub struct PowerCommandsBody {
    enabled: bool,
}

pub async fn handle_scheduler_power_commands(
    State(state): State<SharedState>,
    Json(body): Json<PowerCommandsBody>,
) -> Json<serde_json::Value> {
    state.scheduler.set_power_commands_enabled(body.enabled);
    Json(serde_json::json!({
        "ok": true,
        "powerCommandsEnabled": state.scheduler.power_commands_enabled(),
    }))
}

/// Periodic scheduler tick: evaluate all rules and apply triggered actions.
pub async fn run_scheduler_tick(state: &SharedState) {
    // Compute download-state counters for the QueueEmpty/AllComplete
    // triggers. Locks acquired in documented order: media_jobs → curl_jobs →
    // task_snapshot.
    let (active_count, queued_count, total_count) = {
        let media = lock_or_err!(state.media_jobs);
        let jobs = lock_or_err!(state.curl_jobs);
        let snapshot = lock_or_err!(state.task_snapshot);
        let mut active = 0u32;
        let mut queued = 0u32;
        for job in media.values() {
            match job.task.status.as_str() {
                "downloading" | "active" => active += 1,
                "queued" | "waiting" => queued += 1,
                _ => {}
            }
        }
        for job in jobs.values() {
            match job.task.status.as_str() {
                "downloading" | "active" => active += 1,
                "queued" | "waiting" => queued += 1,
                _ => {}
            }
        }
        (active, queued, snapshot.len() as u32)
    };
    let current_bw = state.bandwidth_manager.effective_global_limit();
    let actions = state
        .scheduler
        .evaluate(current_bw, active_count, queued_count, total_count);
    for action in actions {
        match action {
            SchedulerAction::StartDownload { task_ids } => {
                for tid in &task_ids {
                    log::info!("Scheduler: resuming task {tid}");
                    if let Err(error) = crate::daemon::curl::resume_task(state, tid).await {
                        log::warn!("Scheduler: failed to resume task {tid}: {error}");
                    }
                }
            }
            SchedulerAction::PauseDownload { task_ids } => {
                for tid in &task_ids {
                    log::info!("Scheduler: pausing task {tid}");
                    if let Err(error) = crate::daemon::curl::pause_task(state, tid).await {
                        log::warn!("Scheduler: failed to pause task {tid}: {error}");
                    }
                }
            }
            SchedulerAction::SetBandwidthLimit { kbps } => {
                log::info!("Scheduler: setting global bandwidth limit to {kbps} kbps");
                state.bandwidth_manager.set_global_limit(kbps);
            }
            SchedulerAction::SetPriority { task_ids, priority } => {
                log::info!(
                    "Scheduler: setting priority for {} tasks to {}",
                    task_ids.len(),
                    priority
                );
                let p = priority.parse::<u32>().map_or_else(
                    |_| match priority.to_ascii_lowercase().as_str() {
                        "critical" | "0" => {
                            crate::daemon::engine::priority_queue::DownloadPriority::Critical
                        }
                        "high" | "1" => {
                            crate::daemon::engine::priority_queue::DownloadPriority::High
                        }
                        "low" | "3" => crate::daemon::engine::priority_queue::DownloadPriority::Low,
                        "background" | "4" => {
                            crate::daemon::engine::priority_queue::DownloadPriority::Background
                        }
                        _ => crate::daemon::engine::priority_queue::DownloadPriority::Normal,
                    },
                    crate::daemon::engine::priority_queue::DownloadPriority::from_u32,
                );
                for tid in &task_ids {
                    state.priority_queue.set_priority(tid, p);
                }
            }
            SchedulerAction::Notify { message } => {
                log::info!("Scheduler notification: {message}");
                crate::daemon::telegram::telegram_notify(state, &message).await;
            }
            SchedulerAction::Shutdown => {
                if !state.scheduler.power_commands_enabled() {
                    log::warn!("Scheduler: shutdown blocked — power commands not enabled");
                    continue;
                }
                log::info!("Scheduler: all downloads complete — shutting down the system");
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("shutdown")
                        .args(["/s", "/t", "30"])
                        .spawn();
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("shutdown")
                        .args(["-h", "+1"])
                        .spawn();
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = std::process::Command::new("shutdown")
                        .args(["-h", "+1"])
                        .spawn();
                }
            }
            SchedulerAction::Sleep => {
                if !state.scheduler.power_commands_enabled() {
                    log::warn!("Scheduler: sleep blocked — power commands not enabled");
                    continue;
                }
                log::info!("Scheduler: all downloads complete — putting system to sleep");
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("rundll32.exe")
                        .args(["powrprof.dll,SetSuspendState", "0,1,0"])
                        .spawn();
                }
                #[cfg(target_os = "linux")]
                {
                    let _ = std::process::Command::new("systemctl")
                        .arg("suspend")
                        .spawn();
                }
                #[cfg(target_os = "macos")]
                {
                    // L3: macOS has no systemctl; pmset is the supported API.
                    let _ = std::process::Command::new("pmset").arg("sleepnow").spawn();
                }
            }
        }
    }
}

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
    // Canonicalize once and use the resolved path for both the boundary check
    // and the actual file read, avoiding a TOCTOU window where a symlink could
    // be swapped between validation and hashing.
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            return Json(serde_json::json!({"ok": false, "error": "File not found"}));
        }
    };
    let data_dir = std::path::Path::new(&state.data_dir)
        .canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from(&state.data_dir));
    if !canonical.starts_with(&data_dir) {
        return Json(serde_json::json!({"ok": false, "error": "Path outside data directory"}));
    }
    if !canonical.exists() {
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
            Some(checksum::verify_checksum(&canonical, &algo, expected))
        } else {
            None
        }
    } else {
        checksum::auto_verify(&canonical, &body.expected)
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

// â”€â”€â”€ Engine: Mirror Download â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    // Validate the mirror URL for SSRF before accepting it: mirrors are used
    // for failover downloads (transfer.rs) and otherwise bypass the is_safe_target_url
    // check applied to the original URL.
    crate::daemon::utils::is_safe_target_url(&body.mirror_url)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    let primary_url = {
        let snapshot = lock_or_err!(state.task_snapshot);
        snapshot
            .get(&body.task_id)
            .map(|t| t.url.clone())
            .unwrap_or_default()
    };
    {
        let mut managers = lock_or_err!(state.mirror_managers);
        let manager = managers
            .entry(body.task_id.clone())
            .or_insert_with(|| MirrorManager::new(&primary_url));
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
    Ok(Json(
        serde_json::json!({"ok": true, "task_id": body.task_id}),
    ))
}

// â”€â”€â”€ Plugin API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Engine: Adaptive Connections â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn handle_adaptive_get(
    State(state): State<SharedState>,
    Path(task_id): Path<String>,
) -> Json<serde_json::Value> {
    let trackers = match state.engine_trackers.read() {
        Ok(g) => g,
        Err(_) => {
            return Json(serde_json::json!({"ok": false, "error": "engine_trackers lock poisoned"}))
        }
    };
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

// â”€â”€â”€ Engine: Dynamic Segments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub async fn handle_segments_get(
    State(state): State<SharedState>,
    Path(task_id): Path<String>,
) -> Json<serde_json::Value> {
    let trackers = match state.engine_trackers.read() {
        Ok(g) => g,
        Err(_) => {
            return Json(serde_json::json!({"ok": false, "error": "engine_trackers lock poisoned"}))
        }
    };
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

// â”€â”€â”€ Engine: Metadata Cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Engine: Mirrors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Deserialize)]
pub struct MirrorSetBody {
    task_id: String,
    mirror_url: String,
}

pub async fn handle_mirrors_set(
    State(state): State<SharedState>,
    Json(body): Json<MirrorSetBody>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    // Validate the mirror URL for SSRF before accepting it (see handle_mirrors_add).
    crate::daemon::utils::is_safe_target_url(&body.mirror_url)
        .map_err(|e| (axum::http::StatusCode::BAD_REQUEST, e))?;
    let primary_url = {
        let snapshot = lock_or_err!(state.task_snapshot);
        snapshot
            .get(&body.task_id)
            .map(|t| t.url.clone())
            .unwrap_or_default()
    };
    let mut managers = lock_or_err!(state.mirror_managers);
    let manager = managers
        .entry(body.task_id.clone())
        .or_insert_with(|| MirrorManager::new(&primary_url));
    manager.set_mirrors(vec![MirrorSource {
        url: body.mirror_url.clone(),
        priority: 0,
        region: None,
        bandwidth_estimate: None,
        last_checked: None,
        healthy: true,
    }]);
    Ok(Json(
        serde_json::json!({"ok": true, "task_id": body.task_id, "mirror_url": body.mirror_url}),
    ))
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

/// Extracts the ffmpeg binary from a downloaded archive's bytes into `dest`.
///
/// Returns `Ok(true)` when the binary was found and written, `Ok(false)` when
/// the archive contains no ffmpeg entry (caller reports "binary not found"),
/// and `Err` on zip parse / IO / path-boundary failures.
///
/// Kept as a standalone helper so the zip 4.x extraction contract (central
/// directory read, entry iteration, zip-slip rejection) is covered by unit
/// tests without a live download.
fn extract_ffmpeg_from_zip(
    bytes: &[u8],
    dest: &std::path::Path,
    bin_dir: &std::path::Path,
) -> Result<bool, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("Failed to open downloaded archive: {e}"))?;
    let mut found = false;
    for i in 0..archive.len() {
        if let Ok(mut file) = archive.by_index(i) {
            let name = file.name().to_owned();
            // Zip-slip guard: reject entries whose names contain path
            // traversal (".."), are absolute, or use a Windows
            // drive-letter/UNC root.
            let normalized = name.replace('\\', "/");
            let is_unsafe = normalized.split('/').any(|seg| seg == "..")
                || std::path::Path::new(&normalized).is_absolute()
                || normalized.starts_with('/')
                || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':');
            if is_unsafe {
                log::warn!("Skipping zip entry with unsafe path: {name:?}");
                continue;
            }
            let is_ffmpeg = if cfg!(windows) {
                name.ends_with("ffmpeg.exe")
            } else {
                name.ends_with("/ffmpeg") || name == "ffmpeg"
            };
            if is_ffmpeg {
                // Defense in depth: the resolved destination must stay
                // inside the bin directory.
                if !dest.starts_with(bin_dir) {
                    return Err(
                        "Refusing to write ffmpeg binary outside the bin directory".to_owned()
                    );
                }
                let mut content = Vec::new();
                if std::io::Read::read_to_end(&mut file, &mut content).is_ok() {
                    std::fs::write(dest, &content)
                        .map_err(|e| format!("Failed to write ffmpeg binary: {e}"))?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if let Ok(mut perms) = std::fs::metadata(dest).map(|m| m.permissions()) {
                            perms.set_mode(0o755);
                            let _ = std::fs::set_permissions(dest, perms);
                        }
                    }
                    found = true;
                    break;
                }
            }
        }
    }
    Ok(found)
}

async fn handle_engine_download(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let engine = body.get("engine").and_then(|v| v.as_str()).unwrap_or("");
    let expected_sha256 = body.get("sha256").and_then(|v| v.as_str());

    let bin_dir = std::path::Path::new(&state.resource_dir).join("bin");
    if !bin_dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&bin_dir) {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Could not create bin directory: {e}")
            }));
        }
    }

    let (url, dest): (String, std::path::PathBuf) = match engine {
        "ytdlp" | "yt-dlp" => {
            let url = if cfg!(windows) {
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
            } else {
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
            };
            (
                url.to_owned(),
                bin_dir.join(if cfg!(windows) {
                    "yt-dlp.exe"
                } else {
                    "yt-dlp"
                }),
            )
        }
        "ffmpeg" => {
            let url = if cfg!(windows) {
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
            } else if cfg!(target_os = "macos") {
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-macosarm64-gpl.zip"
            } else {
                "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
            };
            (
                url.to_owned(),
                bin_dir.join(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                }),
            )
        }
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown engine: {engine}")
            }));
        }
    };

    match state.http_client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("Failed to read response: {e}")
                    }));
                }
            };

            // Compute SHA-256 and verify against expected hash if provided.
            let digest = {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                format!("{:x}", hasher.finalize())
            };
            log::info!("Downloaded {engine} binary SHA-256: {digest}");
            if let Some(expected) = expected_sha256 {
                if !digest.eq_ignore_ascii_case(expected) {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("SHA-256 mismatch: expected {expected}, got {digest}")
                    }));
                }
            }

            // For FFmpeg, extract the binary from the zip archive.
            if engine == "ffmpeg" {
                match extract_ffmpeg_from_zip(&bytes, &dest, &bin_dir) {
                    Ok(true) => {}
                    Ok(false) => {
                        return Json(serde_json::json!({
                            "ok": false,
                            "error": "ffmpeg binary not found in the downloaded archive"
                        }));
                    }
                    Err(e) => {
                        return Json(serde_json::json!({
                            "ok": false,
                            "error": e,
                        }));
                    }
                }
            } else if let Err(e) = std::fs::write(&dest, &bytes) {
                return Json(serde_json::json!({
                    "ok": false,
                    "error": format!("Failed to write binary: {e}")
                }));
            }
            let mut version_cmd = std::process::Command::new(&dest);
            hide_command_window(&mut version_cmd);
            let version = version_cmd
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_owned())
                .unwrap_or_default();

            if let Ok(mut cache) = state.engine_capabilities_cache.write() {
                *cache = None;
            }

            Json(serde_json::json!({
                "ok": true,
                "engine": engine,
                "path": dest.display().to_string(),
                "version": version,
            }))
        }
        Ok(resp) => Json(serde_json::json!({
            "ok": false,
            "error": format!("HTTP {} from download URL", resp.status())
        })),
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("Download failed: {e}")
        })),
    }
}

async fn handle_engine_verify(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let engine = body.get("engine").and_then(|v| v.as_str()).unwrap_or("");

    let bin_path = match engine {
        "ytdlp" | "yt-dlp" => state.ytdlp_binary(),
        "ffmpeg" => state.ffmpeg_binary(),
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown engine: {engine}")
            }));
        }
    };

    let exists = std::path::Path::new(&bin_path).exists();
    if !exists {
        return Json(serde_json::json!({
            "ok": false,
            "available": false,
            "error": "Binary not found"
        }));
    }

    let mut verify_cmd = std::process::Command::new(&bin_path);
    hide_command_window(&mut verify_cmd);
    let version = verify_cmd
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_owned())
        .unwrap_or_default();

    Json(serde_json::json!({
        "ok": true,
        "available": true,
        "engine": engine,
        "path": bin_path,
        "version": version,
    }))
}

async fn handle_engine_latest_version(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let engine = body.get("engine").and_then(|v| v.as_str()).unwrap_or("");

    let api_url = match engine {
        "ytdlp" | "yt-dlp" => "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
        "ffmpeg" => {
            return Json(serde_json::json!({
                "ok": true,
                "engine": "ffmpeg",
                "latestVersion": "system",
                "note": "FFmpeg version depends on your system installation. Use your package manager to update."
            }));
        }
        _ => {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown engine: {engine}")
            }));
        }
    };

    match state.http_client.get(api_url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false,
                        "error": format!("Failed to parse response: {e}")
                    }));
                }
            };
            let latest = json
                .get("tag_name")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_owned();
            let ytdlp_bin = state.ytdlp_binary();
            let mut current_cmd = std::process::Command::new(&ytdlp_bin);
            hide_command_window(&mut current_cmd);
            let current = current_cmd
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_owned())
                .unwrap_or_default();

            Json(serde_json::json!({
                "ok": true,
                "engine": engine,
                "latestVersion": latest,
                "currentVersion": current,
                "updateAvailable": latest != current && !current.is_empty(),
            }))
        }
        Ok(resp) => Json(serde_json::json!({
            "ok": false,
            "error": format!("HTTP {} from GitHub API", resp.status())
        })),
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "error": format!("Request failed: {e}")
        })),
    }
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/engines/capabilities", get(handle_engine_capabilities))
        .route("/api/engines/download", post(handle_engine_download))
        .route("/api/engines/verify", post(handle_engine_verify))
        .route(
            "/api/engines/latest-version",
            post(handle_engine_latest_version),
        )
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
        .route(
            "/api/engine/scheduler/power-commands",
            post(handle_scheduler_power_commands),
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
}

#[cfg(test)]
mod tests {
    use super::extract_ffmpeg_from_zip;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    /// Builds an in-memory zip archive with the given (name, content) entries.
    /// Uses the zip crate's writer so the test exercises the same zip 4.x code
    /// path (central directory, entry iteration) that production extraction does.
    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buf);
            let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            for (name, content) in entries {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content).unwrap();
            }
            writer.finish().unwrap();
        }
        buf.into_inner()
    }

    fn test_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nova_engine_zip_test_{tag}_{}", std::process::id()))
    }

    fn ffmpeg_dest_name() -> &'static str {
        if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        }
    }

    #[test]
    fn extracts_ffmpeg_binary_from_zip_archive() {
        let dir = test_dir("ok");
        let _ = std::fs::remove_dir_all(&dir);
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let dest = bin_dir.join(ffmpeg_dest_name());
        let payload: Vec<u8> = (0..4096).map(|i| (i % 251) as u8).collect();

        let archive = build_zip(&[
            ("ffmpeg-master/README.txt", b"readme"),
            ("ffmpeg-master/bin/ffmpeg.exe", &payload),
            ("ffmpeg-master/bin/ffmpeg", &payload),
        ]);

        let found = extract_ffmpeg_from_zip(&archive, &dest, &bin_dir).unwrap();
        assert!(found, "expected ffmpeg binary to be found in the zip");
        let written = std::fs::read(&dest).unwrap();
        assert_eq!(
            written, payload,
            "extracted binary does not match zip entry"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip_slip_entries_are_skipped() {
        let dir = test_dir("slip");
        let _ = std::fs::remove_dir_all(&dir);
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let dest = bin_dir.join(ffmpeg_dest_name());

        // An entry attempting path traversal must be skipped, not extracted.
        let archive = build_zip(&[
            ("../evil.exe", b"evil"),
            ("C:/windows/system32/evil.exe", b"evil2"),
            ("ffmpeg-master/bin/ffmpeg.exe", b"real-ffmpeg"),
            ("ffmpeg-master/bin/ffmpeg", b"real-ffmpeg"),
        ]);

        let found = extract_ffmpeg_from_zip(&archive, &dest, &bin_dir).unwrap();
        assert!(found, "expected ffmpeg binary to be found");
        let written = std::fs::read(&dest).unwrap();
        assert_eq!(written, b"real-ffmpeg");
        // The traversal entries must never be materialised anywhere.
        assert!(!dir.join("evil.exe").exists());
        assert!(!Path::new("evil.exe").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn archive_without_ffmpeg_reports_not_found() {
        let dir = test_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let dest = bin_dir.join(ffmpeg_dest_name());

        let archive = build_zip(&[("docs/manual.txt", b"nothing to see")]);
        let found = extract_ffmpeg_from_zip(&archive, &dest, &bin_dir).unwrap();
        assert!(!found, "archive without ffmpeg must report not-found");
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_archive_returns_error() {
        let dir = test_dir("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        let bin_dir = dir.join("bin");
        std::fs::create_dir_all(&bin_dir).unwrap();
        let dest = bin_dir.join(ffmpeg_dest_name());

        let garbage = b"this is not a zip archive at all";
        let err = extract_ffmpeg_from_zip(garbage, &dest, &bin_dir).unwrap_err();
        assert!(
            err.contains("Failed to open downloaded archive"),
            "unexpected error: {err}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn profile_switch_to_unlimited_clears_previous_bandwidth_cap() {
        use axum::{extract::State, Json};
        use std::sync::Arc;

        let dir = test_dir("profile-limit");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(crate::daemon::persist::tests::test_state(
            &dir.to_string_lossy(),
        ));

        let Json(economical) = super::handle_profiles_set_active(
            State(state.clone()),
            Json(super::ProfileSetActiveBody {
                profile_id: "economical".to_owned(),
            }),
        )
        .await;
        assert_eq!(economical["ok"], true);
        assert_eq!(state.bandwidth_manager.effective_global_limit(), 1024);
        assert_eq!(state.priority_queue.total_bandwidth(), 1024);

        let Json(balanced) = super::handle_profiles_set_active(
            State(state.clone()),
            Json(super::ProfileSetActiveBody {
                profile_id: "balanced".to_owned(),
            }),
        )
        .await;
        assert_eq!(balanced["ok"], true);
        assert_eq!(state.bandwidth_manager.effective_global_limit(), 0);
        assert_eq!(state.priority_queue.total_bandwidth(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
