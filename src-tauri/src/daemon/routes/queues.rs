use std::collections::HashSet;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Local;
use nova_core_model::TaskState;

use crate::daemon::engine::scheduler::queue_schedule_window_active;
use crate::daemon::state::SharedState;
use crate::lock_or_err;

pub const QUEUE_CATALOG_VERSION: u32 = 1;
const MAX_QUEUES: usize = 128;

fn default_queue() -> serde_json::Value {
    serde_json::json!({
        "id": "main",
        "name": "Main Queue",
        "active": true,
        "scheduled": false,
        "scheduleType": "daily",
        "scheduleCompleted": false,
        "startTime": "00:00",
        "endTime": "23:59",
        "days": [0, 1, 2, 3, 4, 5, 6],
        "maxActive": 1,
        "limitSpeed": false,
        "speedLimitKbs": 0,
        "oneTimeLimit": false,
        "shutdownOnComplete": false,
        "hangupOnComplete": false,
        "exitOnComplete": false,
        "retryCount": 3,
        "retryDelay": 10,
        "profileId": "",
        "downloadOrder": []
    })
}

fn clean_id(value: &str) -> String {
    let mut result = String::new();
    let mut dash = false;
    for ch in value.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch);
            dash = false;
        } else if !dash && !result.is_empty() {
            result.push('-');
            dash = true;
        }
    }
    while result.ends_with('-') {
        result.pop();
    }
    if result.is_empty() { "queue".to_owned() } else { result }
}

fn normalized_time(value: Option<&str>, fallback: &str) -> String {
    let Some(raw) = value else { return fallback.to_owned(); };
    let mut parts = raw.trim().split(':');
    let hour = parts.next().and_then(|v| v.parse::<u8>().ok());
    let minute = parts.next().and_then(|v| v.parse::<u8>().ok());
    if parts.next().is_none() && hour.is_some_and(|v| v < 24) && minute.is_some_and(|v| v < 60) {
        format!("{:02}:{:02}", hour.unwrap_or(0), minute.unwrap_or(0))
    } else {
        fallback.to_owned()
    }
}

fn normalized_days(value: Option<&serde_json::Value>) -> serde_json::Value {
    let mut days = value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_u64)
                .filter(|day| *day <= 6)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| vec![0, 1, 2, 3, 4, 5, 6]);
    days.sort_unstable();
    days.dedup();
    if days.is_empty() {
        days = vec![0, 1, 2, 3, 4, 5, 6];
    }
    serde_json::Value::Array(days.into_iter().map(serde_json::Value::from).collect())
}

fn normalized_order(value: Option<&serde_json::Value>) -> serde_json::Value {
    let mut seen = HashSet::new();
    let order = value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert((*id).to_owned()))
        .map(serde_json::Value::from)
        .collect::<Vec<_>>();
    serde_json::Value::Array(order)
}

fn bool_value(object: &serde_json::Map<String, serde_json::Value>, key: &str, fallback: bool) -> bool {
    object.get(key).and_then(serde_json::Value::as_bool).unwrap_or(fallback)
}

fn u64_value(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    fallback: u64,
    min: u64,
    max: u64,
) -> u64 {
    object
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn normalize_queue(
    value: serde_json::Value,
    forced_id: Option<&str>,
    existing_order: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "Queue must be a JSON object".to_owned())?;
    let id = forced_id
        .map(str::to_owned)
        .or_else(|| object.get("id").and_then(serde_json::Value::as_str).map(clean_id))
        .ok_or_else(|| "Queue id is required".to_owned())?;
    if id.trim().is_empty() || id.len() > 96 {
        return Err("Queue id is invalid".to_owned());
    }
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&id);
    if name.len() > 160 {
        return Err("Queue name is too long".to_owned());
    }

    let active_default = id == "main";
    let schedule_type = object
        .get("scheduleType")
        .and_then(serde_json::Value::as_str)
        .filter(|value| matches!(*value, "once" | "daily" | "custom"))
        .unwrap_or("daily");
    let start_time = normalized_time(
        object.get("startTime").and_then(serde_json::Value::as_str),
        "00:00",
    );
    let end_time = normalized_time(
        object.get("endTime").and_then(serde_json::Value::as_str),
        "23:59",
    );
    let order_source = object.get("downloadOrder").or(existing_order);

    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "active": bool_value(object, "active", active_default),
        "scheduled": bool_value(object, "scheduled", false),
        "scheduleType": schedule_type,
        "scheduleCompleted": bool_value(object, "scheduleCompleted", false),
        "startTime": start_time,
        "endTime": end_time,
        "days": normalized_days(object.get("days")),
        "maxActive": u64_value(object, "maxActive", 1, 1, 64),
        "limitSpeed": bool_value(object, "limitSpeed", false),
        "speedLimitKbs": u64_value(object, "speedLimitKbs", 0, 0, 10_000_000),
        "oneTimeLimit": bool_value(object, "oneTimeLimit", false),
        "shutdownOnComplete": bool_value(object, "shutdownOnComplete", false),
        "hangupOnComplete": bool_value(object, "hangupOnComplete", false),
        "exitOnComplete": bool_value(object, "exitOnComplete", false),
        "retryCount": u64_value(object, "retryCount", 3, 0, 9_999),
        "retryDelay": u64_value(object, "retryDelay", 10, 1, 86_400),
        "profileId": object.get("profileId").and_then(serde_json::Value::as_str).unwrap_or(""),
        "downloadOrder": normalized_order(order_source)
    }))
}

pub fn normalize_restored_catalog(values: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in values.into_iter().take(MAX_QUEUES) {
        let Some(id) = value.get("id").and_then(serde_json::Value::as_str).map(str::to_owned) else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Ok(queue) = normalize_queue(value, Some(&id), None) {
            result.push(queue);
        }
    }
    if !result.iter().any(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some("main")) {
        result.insert(0, default_queue());
    }
    result
}

fn catalog_response(state: &SharedState) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "version": QUEUE_CATALOG_VERSION,
        "queues": lock_or_err!(state.queue_catalog).clone()
    })
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({"ok": false, "error": message.into()}))).into_response()
}

fn success_response(value: serde_json::Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

fn queue_exists(state: &SharedState, queue_id: &str) -> bool {
    lock_or_err!(state.queue_catalog)
        .iter()
        .any(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id))
}

fn set_task_queue(state: &SharedState, task_id: &str, queue_id: &str) -> Result<(), String> {
    let mut found = false;
    {
        let mut jobs = lock_or_err!(state.native_media_jobs);
        if let Some(job) = jobs.get_mut(task_id) {
            job.task.queue_id = queue_id.to_owned();
            found = true;
        }
    }
    {
        let mut jobs = lock_or_err!(state.torrent_jobs);
        if let Some(job) = jobs.get_mut(task_id) {
            job.task.queue_id = queue_id.to_owned();
            found = true;
        }
    }
    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(task_id) {
            job.task.queue_id = queue_id.to_owned();
            found = true;
        }
    }
    {
        let mut snapshot = lock_or_err!(state.task_snapshot);
        if let Some(task) = snapshot.get_mut(task_id) {
            task.queue_id = queue_id.to_owned();
            found = true;
        }
    }
    if found {
        state.mark_dirty();
        Ok(())
    } else {
        Err(format!("Task {task_id} was not found"))
    }
}

fn move_order_entry(state: &SharedState, task_id: &str, queue_id: &str) {
    let mut catalog = lock_or_err!(state.queue_catalog);
    for queue in catalog.iter_mut() {
        let Some(object) = queue.as_object_mut() else { continue; };
        let is_target =
            object.get("id").and_then(serde_json::Value::as_str) == Some(queue_id);
        let Some(order) = object
            .get_mut("downloadOrder")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        order.retain(|value| value.as_str() != Some(task_id));
        if is_target {
            order.push(serde_json::Value::from(task_id));
        }
    }
}

pub fn reconcile_state_queue_catalog(state: &SharedState) {
    let known_tasks = lock_or_err!(state.task_snapshot).clone();
    let known_queue_ids = {
        let catalog = lock_or_err!(state.queue_catalog);
        catalog
            .iter()
            .filter_map(|queue| queue.get("id").and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .collect::<HashSet<_>>()
    };

    for task in known_tasks.values() {
        if !known_queue_ids.contains(&task.queue_id) {
            let _ = set_task_queue(state, &task.id, "main");
        }
    }

    let tasks = lock_or_err!(state.task_snapshot).clone();
    let mut catalog = lock_or_err!(state.queue_catalog);
    for queue in catalog.iter_mut() {
        let Some(object) = queue.as_object_mut() else { continue; };
        let queue_id = object.get("id").and_then(serde_json::Value::as_str).unwrap_or("main").to_owned();
        let mut seen = HashSet::new();
        let mut order = object
            .get("downloadOrder")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter(|task_id| tasks.get(*task_id).is_some_and(|task| task.queue_id == queue_id))
            .filter(|task_id| seen.insert((*task_id).to_owned()))
            .map(serde_json::Value::from)
            .collect::<Vec<_>>();
        let mut extras = tasks
            .values()
            .filter(|task| task.queue_id == queue_id && !seen.contains(&task.id))
            .map(|task| task.id.clone())
            .collect::<Vec<_>>();
        extras.sort();
        order.extend(extras.into_iter().map(serde_json::Value::from));
        object.insert("downloadOrder".to_owned(), serde_json::Value::Array(order));
    }
    drop(catalog);
    state.mark_dirty();
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct QueueTickActions {
    pub shutdown: bool,
    pub sleep: bool,
    pub exit: bool,
}

fn set_queue_active(state: &SharedState, queue_id: &str, active: bool) -> Result<(), String> {
    let mut catalog = lock_or_err!(state.queue_catalog);
    let Some(queue) = catalog
        .iter_mut()
        .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return Err(format!("Queue {queue_id} was not found"));
    };
    queue.insert("active".to_owned(), serde_json::Value::Bool(active));
    drop(catalog);
    state.mark_dirty();
    Ok(())
}

fn mark_once_schedule_completed(state: &SharedState, queue_id: &str) {
    let mut catalog = lock_or_err!(state.queue_catalog);
    let Some(queue) = catalog
        .iter_mut()
        .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if queue.get("scheduleType").and_then(serde_json::Value::as_str) == Some("once") {
        queue.insert("scheduleCompleted".to_owned(), serde_json::Value::Bool(true));
        queue.insert("active".to_owned(), serde_json::Value::Bool(false));
        drop(catalog);
        state.mark_dirty();
    }
}

fn ordered_task_ids_for_queue(state: &SharedState, queue_id: &str) -> Vec<String> {
    let snapshot = lock_or_err!(state.task_snapshot).clone();
    let configured = lock_or_err!(state.queue_catalog)
        .iter()
        .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id))
        .and_then(|queue| queue.get("downloadOrder"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut seen = HashSet::new();
    let mut ordered = configured
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .filter(|task_id| {
            snapshot
                .get(task_id)
                .is_some_and(|task| task.queue_id == queue_id)
        })
        .filter(|task_id| seen.insert(task_id.clone()))
        .collect::<Vec<_>>();

    let mut extras = snapshot
        .values()
        .filter(|task| task.queue_id == queue_id && !seen.contains(&task.id))
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    extras.sort();
    ordered.extend(extras);
    ordered
}

async fn fill_queue_slots(
    state: &SharedState,
    queue_id: &str,
    max_active: usize,
    include_paused: bool,
) -> Vec<String> {
    let snapshot = lock_or_err!(state.task_snapshot).clone();
    let active = snapshot
        .values()
        .filter(|task| task.queue_id == queue_id)
        .filter_map(|task| TaskState::from_status(&task.status))
        .filter(|state| state.is_active())
        .count();
    let mut slots = max_active.saturating_sub(active);
    if slots == 0 {
        return Vec::new();
    }

    let mut resumed = Vec::new();
    for task_id in ordered_task_ids_for_queue(state, queue_id) {
        if slots == 0 {
            break;
        }
        let Some(task) = snapshot.get(&task_id) else { continue; };
        let Some(task_state) = TaskState::from_status(&task.status) else { continue; };
        let eligible = task_state == TaskState::Queued
            || (include_paused && task_state == TaskState::Paused);
        if !eligible {
            continue;
        }
        match crate::daemon::curl::resume_task(state, &task_id).await {
            Ok(_) => {
                resumed.push(task_id);
                slots -= 1;
            }
            Err(error) => {
                log::warn!("Queue {queue_id}: failed to resume {task_id}: {error}");
            }
        }
    }
    resumed
}

async fn pause_queue_active_tasks(state: &SharedState, queue_id: &str) -> Vec<String> {
    let snapshot = lock_or_err!(state.task_snapshot).clone();
    let task_ids = snapshot
        .values()
        .filter(|task| task.queue_id == queue_id)
        .filter(|task| {
            TaskState::from_status(&task.status)
                .is_some_and(TaskState::is_active)
        })
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();

    let mut paused = Vec::new();
    for task_id in task_ids {
        match crate::daemon::curl::pause_task(state, &task_id).await {
            Ok(_) => paused.push(task_id),
            Err(error) => log::warn!("Queue {queue_id}: failed to pause {task_id}: {error}"),
        }
    }
    paused
}

fn queue_max_active(queue: &serde_json::Value) -> usize {
    queue
        .get("maxActive")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(1)
        .clamp(1, 64) as usize
}

pub async fn handle_queue_start(
    State(state): State<SharedState>,
    Path(queue_id): Path<String>,
) -> Response {
    let queue = {
        let catalog = lock_or_err!(state.queue_catalog);
        catalog
            .iter()
            .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id.as_str()))
            .cloned()
    };
    let Some(queue) = queue else {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    };
    if let Err(error) = set_queue_active(&state, &queue_id, true) {
        return error_response(StatusCode::NOT_FOUND, error);
    }
    let resumed = fill_queue_slots(&state, &queue_id, queue_max_active(&queue), true).await;
    let mut response = catalog_response(&state);
    if let Some(object) = response.as_object_mut() {
        object.insert("resumedTaskIds".to_owned(), serde_json::json!(resumed));
    }
    success_response(response)
}

pub async fn handle_queue_stop(
    State(state): State<SharedState>,
    Path(queue_id): Path<String>,
) -> Response {
    if !queue_exists(&state, &queue_id) {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    }
    if let Err(error) = set_queue_active(&state, &queue_id, false) {
        return error_response(StatusCode::NOT_FOUND, error);
    }
    let paused = pause_queue_active_tasks(&state, &queue_id).await;
    let mut response = catalog_response(&state);
    if let Some(object) = response.as_object_mut() {
        object.insert("pausedTaskIds".to_owned(), serde_json::json!(paused));
    }
    success_response(response)
}

/// Apply daemon-owned queue scheduling, concurrency and retry policy.
///
/// This runs on the existing scheduler tick. No UI client is required for
/// queued work to advance, and schedule windows survive desktop restarts.
pub async fn run_queue_scheduler_tick(state: &SharedState) -> QueueTickActions {
    let now = Local::now();
    let catalog = lock_or_err!(state.queue_catalog).clone();
    let mut completion_actions = QueueTickActions::default();

    for queue in catalog {
        let Some(queue_id) = queue.get("id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let scheduled = queue.get("scheduled").and_then(serde_json::Value::as_bool).unwrap_or(false);
        let schedule_active = scheduled && queue_schedule_window_active(&queue, &now);
        let (entered, exited) = if scheduled {
            state.scheduler.queue_window_transition(queue_id, schedule_active)
        } else {
            state.scheduler.queue_window_transition(queue_id, false)
        };

        if entered {
            let _ = set_queue_active(state, queue_id, true);
        }
        if exited {
            let _ = set_queue_active(state, queue_id, false);
            let _ = pause_queue_active_tasks(state, queue_id).await;
            mark_once_schedule_completed(state, queue_id);
        }

        let active = if scheduled {
            schedule_active
        } else {
            queue.get("active").and_then(serde_json::Value::as_bool).unwrap_or(false)
        };
        if active {
            let _ = fill_queue_slots(state, queue_id, queue_max_active(&queue), entered).await;

            let retry_count = queue
                .get("retryCount")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(3)
                .min(u32::MAX as u64) as u32;
            let retry_delay = queue
                .get("retryDelay")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(10)
                .max(1);
            let snapshot = lock_or_err!(state.task_snapshot).clone();
            let active_count = snapshot
                .values()
                .filter(|task| task.queue_id == queue_id)
                .filter_map(|task| TaskState::from_status(&task.status))
                .filter(|status| status.is_active())
                .count();
            let mut remaining_slots = queue_max_active(&queue).saturating_sub(active_count);
            if remaining_slots > 0 {
                for task_id in ordered_task_ids_for_queue(state, queue_id) {
                    if remaining_slots == 0 {
                        break;
                    }
                    let failed = snapshot
                        .get(&task_id)
                        .and_then(|task| TaskState::from_status(&task.status))
                        == Some(TaskState::Failed);
                    if state.scheduler.queue_retry_due(
                        queue_id,
                        &task_id,
                        failed,
                        retry_count,
                        retry_delay,
                    ) {
                        match crate::daemon::curl::resume_task(state, &task_id).await {
                            Ok(_) => remaining_slots -= 1,
                            Err(error) => log::warn!(
                                "Queue {queue_id}: retry resume failed for {task_id}: {error}"
                            ),
                        }
                    } else if !failed {
                        let _ = state.scheduler.queue_retry_due(
                            queue_id,
                            &task_id,
                            false,
                            retry_count,
                            retry_delay,
                        );
                    }
                }
            }
        }

        let snapshot = lock_or_err!(state.task_snapshot).clone();
        let members = snapshot
            .values()
            .filter(|task| task.queue_id == queue_id)
            .collect::<Vec<_>>();
        let completed = !members.is_empty()
            && members.iter().all(|task| {
                TaskState::from_status(&task.status) == Some(TaskState::Completed)
            });
        if state.scheduler.queue_completion_edge(queue_id, completed) {
            completion_actions.shutdown |= queue
                .get("shutdownOnComplete")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            completion_actions.sleep |= queue
                .get("hangupOnComplete")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            completion_actions.exit |= queue
                .get("exitOnComplete")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if queue.get("scheduleType").and_then(serde_json::Value::as_str) == Some("once") {
                mark_once_schedule_completed(state, queue_id);
            }
        }
    }

    completion_actions
}

pub async fn handle_queue_list(State(state): State<SharedState>) -> Response {
    success_response(catalog_response(&state))
}

#[derive(serde::Deserialize)]
pub struct QueueCreateBody {
    name: String,
    #[serde(rename = "taskId")]
    task_id: Option<String>,
}

pub async fn handle_queue_create(
    State(state): State<SharedState>,
    Json(body): Json<QueueCreateBody>,
) -> Response {
    let name = body.name.trim();
    if name.is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "Queue name cannot be empty");
    }

    let queue = {
        let mut catalog = lock_or_err!(state.queue_catalog);
        if catalog.len() >= MAX_QUEUES {
            return error_response(StatusCode::CONFLICT, "Maximum queue count reached");
        }
        let base = clean_id(name);
        let mut id = base.clone();
        let mut suffix = 2u32;
        while catalog.iter().any(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())) {
            id = format!("{base}-{suffix}");
            suffix = suffix.saturating_add(1);
        }
        let mut value = default_queue();
        if let Some(object) = value.as_object_mut() {
            object.insert("id".to_owned(), serde_json::Value::from(id.clone()));
            object.insert("name".to_owned(), serde_json::Value::from(name));
            object.insert("active".to_owned(), serde_json::Value::Bool(false));
        }
        catalog.push(value.clone());
        value
    };

    if let Some(task_id) = body.task_id.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        let queue_id = queue.get("id").and_then(serde_json::Value::as_str).unwrap_or("main");
        if let Err(error) = set_task_queue(&state, task_id, queue_id) {
            lock_or_err!(state.queue_catalog).retain(|item| item.get("id") != queue.get("id"));
            return error_response(StatusCode::NOT_FOUND, error);
        }
        move_order_entry(&state, task_id, queue_id);
    }
    state.mark_dirty();

    let mut response = catalog_response(&state);
    if let Some(object) = response.as_object_mut() {
        object.insert("queue".to_owned(), queue);
    }
    success_response(response)
}

#[derive(serde::Deserialize)]
pub struct QueueUpdateBody {
    queue: serde_json::Value,
}

pub async fn handle_queue_update(
    State(state): State<SharedState>,
    Path(queue_id): Path<String>,
    Json(body): Json<QueueUpdateBody>,
) -> Response {
    let mut catalog = lock_or_err!(state.queue_catalog);
    let Some(index) = catalog
        .iter()
        .position(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id.as_str()))
    else {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    };
    let existing_order = catalog[index].get("downloadOrder").cloned();
    let updated = match normalize_queue(body.queue, Some(&queue_id), existing_order.as_ref()) {
        Ok(queue) => queue,
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    catalog[index] = updated.clone();
    drop(catalog);

    let limit_speed = updated.get("limitSpeed").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let speed_limit = updated.get("speedLimitKbs").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let task_ids = updated
        .get("downloadOrder")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    for task_id in task_ids {
        if limit_speed && speed_limit > 0 {
            state.bandwidth_manager.set_task_limit(task_id, speed_limit);
        } else {
            state.bandwidth_manager.remove_task_limit(&task_id);
        }
    }

    state.mark_dirty();
    let mut response = catalog_response(&state);
    if let Some(object) = response.as_object_mut() {
        object.insert("queue".to_owned(), updated);
    }
    success_response(response)
}

pub async fn handle_queue_delete(
    State(state): State<SharedState>,
    Path(queue_id): Path<String>,
) -> Response {
    if queue_id == "main" {
        return error_response(StatusCode::BAD_REQUEST, "The main queue cannot be deleted");
    }
    if !queue_exists(&state, &queue_id) {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    }

    let task_ids = lock_or_err!(state.task_snapshot)
        .values()
        .filter(|task| task.queue_id == queue_id)
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    for task_id in &task_ids {
        let _ = set_task_queue(&state, task_id, "main");
    }

    {
        let mut catalog = lock_or_err!(state.queue_catalog);
        catalog.retain(|queue| queue.get("id").and_then(serde_json::Value::as_str) != Some(queue_id.as_str()));
        if let Some(main) = catalog
            .iter_mut()
            .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some("main"))
            .and_then(serde_json::Value::as_object_mut)
        {
            let order = main
                .entry("downloadOrder")
                .or_insert_with(|| serde_json::json!([]))
                .as_array_mut()
                .expect("downloadOrder normalized as array");
            let existing = order
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            for task_id in task_ids {
                if !existing.contains(&task_id) {
                    order.push(serde_json::Value::from(task_id));
                }
            }
        }
    }
    state.mark_dirty();
    success_response(catalog_response(&state))
}

#[derive(serde::Deserialize)]
pub struct QueueReorderBody {
    #[serde(rename = "queueIds")]
    queue_ids: Vec<String>,
}

pub async fn handle_queue_reorder(
    State(state): State<SharedState>,
    Json(body): Json<QueueReorderBody>,
) -> Response {
    let mut catalog = lock_or_err!(state.queue_catalog);
    let current_ids = catalog
        .iter()
        .filter_map(|queue| queue.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let requested = body
        .queue_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let current_set = current_ids.iter().cloned().collect::<HashSet<_>>();
    let requested_set = requested.iter().cloned().collect::<HashSet<_>>();
    if current_set != requested_set || requested.len() != requested_set.len() {
        return error_response(StatusCode::BAD_REQUEST, "queueIds must contain every queue exactly once");
    }
    let mut reordered = Vec::with_capacity(catalog.len());
    for id in requested {
        if let Some(index) = catalog.iter().position(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str())) {
            reordered.push(catalog.remove(index));
        }
    }
    *catalog = reordered;
    drop(catalog);
    state.mark_dirty();
    success_response(catalog_response(&state))
}

#[derive(serde::Deserialize)]
pub struct QueueTaskReorderBody {
    #[serde(rename = "taskIds")]
    task_ids: Vec<String>,
}

pub async fn handle_queue_reorder_tasks(
    State(state): State<SharedState>,
    Path(queue_id): Path<String>,
    Json(body): Json<QueueTaskReorderBody>,
) -> Response {
    if !queue_exists(&state, &queue_id) {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    }
    let expected = lock_or_err!(state.task_snapshot)
        .values()
        .filter(|task| task.queue_id == queue_id)
        .map(|task| task.id.clone())
        .collect::<HashSet<_>>();
    let requested = body
        .task_ids
        .into_iter()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let requested_set = requested.iter().cloned().collect::<HashSet<_>>();
    if expected != requested_set || requested.len() != requested_set.len() {
        return error_response(StatusCode::BAD_REQUEST, "taskIds must contain every task in the queue exactly once");
    }

    let mut catalog = lock_or_err!(state.queue_catalog);
    let Some(queue) = catalog
        .iter_mut()
        .find(|queue| queue.get("id").and_then(serde_json::Value::as_str) == Some(queue_id.as_str()))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    };
    queue.insert(
        "downloadOrder".to_owned(),
        serde_json::Value::Array(requested.into_iter().map(serde_json::Value::from).collect()),
    );
    drop(catalog);
    state.mark_dirty();
    success_response(catalog_response(&state))
}

pub async fn handle_queue_move_task(
    State(state): State<SharedState>,
    Path((queue_id, task_id)): Path<(String, String)>,
) -> Response {
    if !queue_exists(&state, &queue_id) {
        return error_response(StatusCode::NOT_FOUND, "Queue was not found");
    }
    if let Err(error) = set_task_queue(&state, &task_id, &queue_id) {
        return error_response(StatusCode::NOT_FOUND, error);
    }
    move_order_entry(&state, &task_id, &queue_id);
    state.mark_dirty();
    success_response(catalog_response(&state))
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/queues", get(handle_queue_list).post(handle_queue_create))
        .route("/api/queues/reorder", post(handle_queue_reorder))
        .route("/api/queues/{queue_id}/start", post(handle_queue_start))
        .route("/api/queues/{queue_id}/stop", post(handle_queue_stop))
        .route(
            "/api/queues/{queue_id}/tasks/reorder",
            post(handle_queue_reorder_tasks),
        )
        .route(
            "/api/queues/{queue_id}/tasks/{task_id}",
            post(handle_queue_move_task),
        )
        .route(
            "/api/queues/{queue_id}",
            post(handle_queue_update).delete(handle_queue_delete),
        )
}

#[cfg(test)]
mod tests {
    use super::{normalize_restored_catalog, normalize_queue};

    #[test]
    fn restored_catalog_keeps_empty_custom_queues() {
        let queues = normalize_restored_catalog(vec![
            serde_json::json!({"id":"main","name":"Main Queue","downloadOrder":[]}),
            serde_json::json!({"id":"night","name":"Night","maxActive":2,"downloadOrder":[]}),
        ]);
        assert_eq!(queues.len(), 2);
        assert_eq!(queues[1]["id"], "night");
        assert_eq!(queues[1]["downloadOrder"], serde_json::json!([]));
    }

    #[test]
    fn queue_normalization_clamps_limits_and_preserves_order() {
        let queue = normalize_queue(
            serde_json::json!({
                "id":"night",
                "name":"Night",
                "maxActive":999,
                "retryCount":99999,
                "retryDelay":0,
                "days":[6,6,9,0]
            }),
            Some("night"),
            Some(&serde_json::json!(["a","b"]))
        ).expect("valid queue");
        assert_eq!(queue["maxActive"], 64);
        assert_eq!(queue["retryCount"], 9_999);
        assert_eq!(queue["retryDelay"], 1);
        assert_eq!(queue["days"], serde_json::json!([0,6]));
        assert_eq!(queue["downloadOrder"], serde_json::json!(["a","b"]));
    }
}
