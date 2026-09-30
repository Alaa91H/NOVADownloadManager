//! Versioned Control Plane command adapter. Existing HTTP handlers remain
//! domain adapters during migration and are called through the shared bus.

use crate::daemon::command_bus::CommandReceipt;
use crate::daemon::routes::downloads;
use crate::daemon::state::SharedState;
use crate::daemon::torrent_task::CreateTorrentBody;
use crate::daemon::types::{CreateDownloadBody, Task};
use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use nova_core_model::{
    BatchMode, CommandEnvelope, CommandScope, ControlCommand, ControlEvent, ControlQuery,
    Principal, QueryEnvelope, QueryPage, StructuredError, CONTROL_EVENT_SCHEMA_VERSION,
    CONTROL_PLANE_CONTRACT_VERSION,
};
use serde::Serialize;
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/v1/commands", post(handle_command))
        .route("/api/v1/queries", post(handle_query))
}

/// Route legacy and in-process clients through the same command validation and
/// permission boundary. A caller-supplied key is honored when available;
/// otherwise a unique key preserves legacy behavior without false replays.
pub(crate) fn execute_legacy<'a>(
    state: &'a SharedState,
    command: ControlCommand,
    idempotency_key: Option<String>,
) -> Pin<Box<dyn Future<Output = Result<Value, StructuredError>> + Send + 'a>> {
    Box::pin(async move {
        let request_id = uuid::Uuid::new_v4().to_string();
        let envelope = CommandEnvelope {
            contract_version: CONTROL_PLANE_CONTRACT_VERSION,
            request_id: request_id.clone(),
            idempotency_key: idempotency_key.unwrap_or_else(|| format!("legacy-{request_id}")),
            command,
        };
        let command_state = state.clone();
        let principal = Principal::local_admin();
        state
            .command_bus
            .execute(&principal, envelope, move |command| async move {
                let result = execute_command(command_state.clone(), command).await;
                if result.is_ok() {
                    command_state.mark_dirty();
                }
                result
            })
            .await
            .map(|receipt| receipt.result)
    })
}

pub(crate) async fn query_legacy(
    state: &SharedState,
    query: ControlQuery,
) -> Result<Value, StructuredError> {
    let principal = Principal::local_admin();
    execute_query_envelope(
        state,
        QueryEnvelope {
            contract_version: CONTROL_PLANE_CONTRACT_VERSION,
            request_id: uuid::Uuid::new_v4().to_string(),
            query,
        },
        &principal,
    )
    .await
}

pub(crate) async fn list_all_tasks_query(
    state: &SharedState,
) -> Result<Vec<Task>, StructuredError> {
    let mut filter = nova_core_model::TaskQueryFilter {
        limit: Some(1000),
        ..Default::default()
    };
    let mut tasks = Vec::new();
    let mut previous_cursor: Option<String> = None;
    loop {
        let page = query_legacy(
            state,
            ControlQuery::ListTasks {
                filter: filter.clone(),
            },
        )
        .await?;
        let items = page
            .get("items")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let page_tasks: Vec<Task> = serde_json::from_value(items).map_err(|error| {
            StructuredError::new(
                "query_result_invalid",
                format!("Task query result did not match the task contract: {error}"),
                500,
                false,
            )
        })?;
        tasks.extend(page_tasks);
        let next_cursor = page
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let Some(next_cursor) = next_cursor else {
            return Ok(tasks);
        };
        if previous_cursor.as_deref() == Some(next_cursor.as_str()) {
            return Err(StructuredError::new(
                "query_cursor_stalled",
                "Task pagination returned the same cursor twice.",
                500,
                false,
            ));
        }
        filter.cursor = Some(next_cursor.clone());
        previous_cursor = Some(next_cursor);
    }
}

pub(crate) async fn add_download_from_body(
    state: &SharedState,
    body: CreateDownloadBody,
    idempotency_key: Option<String>,
) -> Result<Task, StructuredError> {
    let use_media_command = body.media_options.is_some();
    let request = serde_json::to_value(body).map_err(|error| {
        StructuredError::new(
            "invalid_command_payload",
            format!("Download request could not be encoded: {error}"),
            400,
            false,
        )
    })?;
    let command = if use_media_command {
        ControlCommand::AddMediaDownload { request }
    } else {
        ControlCommand::AddDownload { request }
    };
    let result = execute_legacy(state, command, idempotency_key).await?;
    serde_json::from_value(result).map_err(|error| {
        StructuredError::new(
            "command_result_invalid",
            format!("Download result did not match the shared task contract: {error}"),
            500,
            false,
        )
    })
}

pub(crate) async fn add_torrent_from_body(
    state: &SharedState,
    body: CreateTorrentBody,
    idempotency_key: Option<String>,
) -> Result<Task, StructuredError> {
    let request = serde_json::to_value(body).map_err(|error| {
        StructuredError::new(
            "invalid_command_payload",
            format!("Torrent request could not be encoded: {error}"),
            400,
            false,
        )
    })?;
    let result = execute_legacy(
        state,
        ControlCommand::AddTorrent { request },
        idempotency_key,
    )
    .await?;
    serde_json::from_value(result).map_err(|error| {
        StructuredError::new(
            "command_result_invalid",
            format!("Torrent result did not match the shared task contract: {error}"),
            500,
            false,
        )
    })
}

pub(crate) fn structured_error_to_http(error: StructuredError) -> (StatusCode, Json<Value>) {
    let status =
        StatusCode::from_u16(error.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        Json(serde_json::json!({
            "error": error.message,
            "code": error.code,
        })),
    )
}

async fn handle_command(
    State(state): State<SharedState>,
    Extension(principal): Extension<Principal>,
    Json(envelope): Json<CommandEnvelope>,
) -> Result<Json<CommandReceipt>, (StatusCode, Json<Value>)> {
    let request_id = envelope.request_id.clone();
    let command_state = state.clone();
    let result = state
        .command_bus
        .execute(&principal, envelope, move |command| async move {
            let result = execute_command(command_state.clone(), command).await;
            if result.is_ok() {
                command_state.mark_dirty();
            }
            result
        })
        .await;

    match result {
        Ok(receipt) => Ok(Json(receipt)),
        Err(error) => {
            let status = StatusCode::from_u16(error.http_status)
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            Err((
                status,
                Json(serde_json::json!({
                    "contractVersion": CONTROL_PLANE_CONTRACT_VERSION,
                    "requestId": request_id,
                    "error": error,
                })),
            ))
        }
    }
}

async fn handle_query(
    State(state): State<SharedState>,
    Extension(principal): Extension<Principal>,
    Json(envelope): Json<QueryEnvelope>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let request_id = envelope.request_id.clone();
    match execute_query_envelope(&state, envelope, &principal).await {
        Ok(result) => Ok(Json(serde_json::json!({
            "contractVersion": CONTROL_PLANE_CONTRACT_VERSION,
            "requestId": request_id,
            "result": result,
        }))),
        Err(error) => Err(query_error_response(&request_id, error)),
    }
}

async fn execute_query_envelope(
    state: &SharedState,
    envelope: QueryEnvelope,
    principal: &Principal,
) -> Result<Value, StructuredError> {
    envelope.validate()?;
    if !principal.allows(CommandScope::Read) {
        return Err(StructuredError::new(
            "permission_denied",
            "The principal lacks the required Read scope.",
            403,
            false,
        ));
    }
    execute_query(state, envelope.query).await
}

fn query_error_response(request_id: &str, error: StructuredError) -> (StatusCode, Json<Value>) {
    let status =
        StatusCode::from_u16(error.http_status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        Json(serde_json::json!({
            "contractVersion": CONTROL_PLANE_CONTRACT_VERSION,
            "requestId": request_id,
            "error": error,
        })),
    )
}

async fn execute_query(state: &SharedState, query: ControlQuery) -> Result<Value, StructuredError> {
    match query {
        ControlQuery::Capabilities => {
            let axum::Json(capabilities) =
                crate::daemon::routes::engine::handle_engine_capabilities(State(state.clone()))
                    .await;
            Ok(capabilities)
        }
        ControlQuery::ListQueues => Ok(crate::daemon::routes::queues::list_queues_query(state)),
        ControlQuery::ListProfiles => Ok(serde_json::json!({
            "ok": true,
            "profiles": state.profile_manager.list_profiles(),
            "active_profile": state.profile_manager.active_profile().id,
        })),
        ControlQuery::GetProfile { profile_id } => {
            match state.profile_manager.get_profile(&profile_id) {
                Some(profile) => {
                    let adaptive = profile.to_adaptive_config();
                    let retry = profile.to_retry_policy();
                    Ok(serde_json::json!({
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
                            "retry": crate::daemon::routes::engine::retry_policy_json(&retry),
                        },
                    }))
                }
                None => Err(StructuredError::new(
                    "not_found",
                    "Profile was not found.",
                    404,
                    false,
                )),
            }
        }
        ControlQuery::ListRules => Ok(serde_json::json!({
            "ok": true,
            "rules": state.rule_engine.rules(),
        })),
        ControlQuery::ListSchedules => Ok(serde_json::json!({
            "ok": true,
            "rules": state.scheduler.rules(),
            "active_rule_ids": state.scheduler.active_rule_ids(),
            "powerCommandsEnabled": state.scheduler.power_commands_enabled(),
            "exitRequested": state.scheduler.exit_requested(),
        })),
        ControlQuery::GetTask { task_id } => {
            let task = crate::daemon::curl::get_task(state, &task_id).ok_or_else(|| {
                StructuredError::new("not_found", "Task was not found.", 404, false)
            })?;
            to_value(task)
        }
        ControlQuery::ListTasks { filter } => {
            let mut tasks = crate::daemon::curl::list_all_tasks(state).await;
            // Engine job maps are hash-backed. Sort before applying the task-ID
            // keyset cursor so successive pages retain a deterministic order.
            tasks.sort_unstable_by(|left, right| left.id.cmp(&right.id));
            if let Some(statuses) = filter.status {
                let statuses: Vec<String> = statuses
                    .into_iter()
                    .map(|status| status.trim().to_ascii_lowercase())
                    .collect();
                tasks.retain(|task| {
                    statuses
                        .iter()
                        .any(|status| task.status.eq_ignore_ascii_case(status))
                });
            }
            if let Some(queue_id) = filter.queue_id {
                tasks.retain(|task| task.queue_id == queue_id);
            }
            if let Some(category) = filter.category {
                tasks.retain(|task| task.category.eq_ignore_ascii_case(&category));
            }
            let total = tasks.len();
            let offset = filter
                .cursor
                .as_deref()
                .map(|cursor| tasks.partition_point(|task| task.id.as_str() <= cursor))
                .unwrap_or(0);
            let limit = filter.limit.unwrap_or(100) as usize;
            let end = offset.saturating_add(limit).min(total);
            let next_cursor = (end < total).then(|| tasks[end - 1].id.clone());
            let page = QueryPage {
                contract_version: CONTROL_PLANE_CONTRACT_VERSION,
                items: tasks.into_iter().skip(offset).take(limit).collect(),
                next_cursor,
                total: Some(total as u64),
            };
            to_value(page)
        }
        ControlQuery::Diagnostics => {
            let axum::Json(diagnostics) =
                crate::daemon::routes::diagnostics::handle_diagnostics(State(state.clone())).await;
            Ok(diagnostics)
        }
        ControlQuery::RecentLogs { limit, level } => {
            let min_level = match level
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                None => None,
                Some("trace") => Some(log::LevelFilter::Trace),
                Some("debug") => Some(log::LevelFilter::Debug),
                Some("info") => Some(log::LevelFilter::Info),
                Some("warn") => Some(log::LevelFilter::Warn),
                Some("error") => Some(log::LevelFilter::Error),
                Some(_) => {
                    return Err(StructuredError::new(
                        "invalid_log_level",
                        "Log level must be trace, debug, info, warn, or error.",
                        400,
                        false,
                    ));
                }
            };
            let mut entries = serde_json::to_value(crate::logging::recent(
                limit.unwrap_or(500) as usize,
                min_level,
            ))
            .map_err(|error| {
                StructuredError::new(
                    "log_encoding_failed",
                    format!("Recent log entries could not be encoded: {error}"),
                    500,
                    false,
                )
            })?;
            redact_event_data(&mut entries, None, &state.api_token);
            if let Some(items) = entries.as_array_mut() {
                for entry in items {
                    let Some(context) = entry.get_mut("context").and_then(Value::as_array_mut)
                    else {
                        continue;
                    };
                    for item in context {
                        let key = item
                            .get("key")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_ascii_lowercase();
                        if [
                            "token",
                            "authorization",
                            "password",
                            "cookie",
                            "secret",
                            "credential",
                        ]
                        .iter()
                        .any(|marker| key.contains(marker))
                        {
                            if let Some(value) = item.get_mut("value") {
                                *value = Value::String("[redacted]".to_owned());
                            }
                        } else if let Some(value) = item.get_mut("value") {
                            redact_event_data(value, Some(&key), &state.api_token);
                        }
                    }
                }
            }
            let count = entries.as_array().map_or(0, Vec::len);
            Ok(serde_json::json!({
                "entries": entries,
                "level": crate::logging::current_level().to_string().to_ascii_lowercase(),
                "count": count,
            }))
        }
        ControlQuery::Events { cursor, limit } => {
            let after = cursor
                .as_deref()
                .unwrap_or("0")
                .parse::<u64>()
                .map_err(|_| {
                    StructuredError::new(
                        "invalid_cursor",
                        "Event cursor must be an unsigned event ID.",
                        400,
                        false,
                    )
                })?;
            let limit = limit.unwrap_or(100) as usize;
            let mut events: Vec<_> = state
                .event_bus
                .recent_events(10_000)
                .into_iter()
                .filter(|event| event.id > after)
                .map(|event| control_event(event, &state.api_token))
                .collect::<Result<_, _>>()?;
            if let Some(first) = events.first() {
                if after.saturating_add(1) < first.event_id {
                    return Err(StructuredError::new(
                        "event_cursor_expired",
                        "Requested event history is older than the retained snapshot.",
                        410,
                        false,
                    )
                    .with_details(serde_json::json!({
                        "earliestRetainedEventId": first.event_id,
                        "restartCursor": first.event_id.saturating_sub(1),
                    })));
                }
            }
            let has_more = events.len() > limit;
            events.truncate(limit);
            let next_cursor = if has_more {
                events.last().map(|event| event.event_id.to_string())
            } else {
                None
            };
            to_value(QueryPage {
                contract_version: CONTROL_PLANE_CONTRACT_VERSION,
                items: events,
                next_cursor,
                total: None,
            })
        }
    }
}

async fn execute_command(
    state: SharedState,
    command: ControlCommand,
) -> Result<Value, StructuredError> {
    match command {
        ControlCommand::Batch { mode, commands } => {
            if mode == BatchMode::Atomic {
                return Err(StructuredError::new(
                    "atomic_batch_unavailable",
                    "Atomic batches are unavailable because download engines do not yet provide transactional rollback.",
                    501,
                    false,
                ));
            }
            let mut succeeded = 0usize;
            let mut failed = 0usize;
            let mut items = Vec::with_capacity(commands.len());
            for (index, command) in commands.into_iter().enumerate() {
                match execute_single(&state, command).await {
                    Ok(result) => {
                        succeeded += 1;
                        items.push(serde_json::json!({
                            "index": index,
                            "ok": true,
                            "result": result,
                        }));
                    }
                    Err(error) => {
                        failed += 1;
                        items.push(serde_json::json!({
                            "index": index,
                            "ok": false,
                            "error": error,
                        }));
                    }
                }
            }
            Ok(serde_json::json!({
                "mode": "bestEffort",
                "total": succeeded + failed,
                "succeeded": succeeded,
                "failed": failed,
                "items": items,
            }))
        }
        single => execute_single(&state, single).await,
    }
}

async fn execute_single(
    state: &SharedState,
    command: ControlCommand,
) -> Result<Value, StructuredError> {
    match command {
        ControlCommand::AddDownload { request } => {
            let body = decode_request::<CreateDownloadBody>(request)?;
            if let Some(url) = body
                .url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
            {
                let is_magnet = url
                    .get(..7)
                    .is_some_and(|scheme| scheme.eq_ignore_ascii_case("magnet:"));
                require_runtime_capability(
                    state,
                    if is_magnet {
                        "torrent.core"
                    } else {
                        "download.direct"
                    },
                )?;
            }
            match downloads::create_download_service(state.clone(), body).await {
                Ok(task) => to_value(task),
                Err((status, Json(body))) => Err(route_error(state, status, body)),
            }
        }
        ControlCommand::AddMediaDownload { request } => {
            let mut body = decode_request::<CreateDownloadBody>(request)?;
            require_runtime_capability(state, "media.extraction")?;
            if body.media_options.is_none() {
                body.media_options = Some(crate::daemon::types::MediaDownloadOptions::default());
            }
            match downloads::create_download_service(state.clone(), body).await {
                Ok(task) => to_value(task),
                Err((status, Json(body))) => Err(route_error(state, status, body)),
            }
        }
        ControlCommand::AddMediaPlaylist { request } => {
            let body = decode_request::<downloads::CreateNativeMediaPlaylistBody>(request)?;
            require_runtime_capability(state, "media.extraction")?;
            match downloads::create_native_media_playlist_service(state.clone(), body).await {
                Ok(Json(result)) => Ok(result),
                Err((status, Json(body))) => Err(route_error(state, status, body)),
            }
        }
        ControlCommand::AddTorrent { request } => {
            let body = decode_request::<crate::daemon::torrent_task::CreateTorrentBody>(request)?;
            require_runtime_capability(state, "torrent.core")?;
            crate::daemon::torrent_task::create_torrent_task(state, body)
                .await
                .map_err(domain_error)
                .and_then(to_value)
        }
        ControlCommand::UpdateTask { task_id, request } => {
            let body = decode_request::<downloads::UpdateDownloadBody>(request)?;
            downloads::update_task_service(state, &task_id, body)
                .await
                .map_err(domain_error)
                .and_then(to_value)
        }
        ControlCommand::PauseTask { task_id } => crate::daemon::curl::pause_task(state, &task_id)
            .await
            .map_err(domain_error)
            .and_then(to_value),
        ControlCommand::ResumeTask { task_id } | ControlCommand::RetryTask { task_id } => {
            crate::daemon::curl::resume_task(state, &task_id)
                .await
                .map_err(domain_error)
                .and_then(to_value)
        }
        ControlCommand::RedownloadTask { task_id } => {
            crate::daemon::curl::redownload_task(state, &task_id)
                .await
                .map_err(domain_error)
                .and_then(to_value)
        }
        ControlCommand::DeleteTask {
            task_id,
            delete_files,
        } => crate::daemon::curl::delete_task(state, &task_id, delete_files)
            .await
            .map(|()| serde_json::json!({"ok": true, "deleteFiles": delete_files}))
            .map_err(domain_error),
        ControlCommand::MoveTask { task_id, queue_id } => {
            crate::daemon::routes::queues::move_task_to_queue(state, &task_id, &queue_id)
                .map_err(|message| StructuredError::new("not_found", message, 404, false))
        }
        ControlCommand::StartQueue { queue_id } => {
            crate::daemon::routes::queues::start_queue_service(state, &queue_id).await
        }
        ControlCommand::StopQueue { queue_id } => {
            crate::daemon::routes::queues::stop_queue_service(state, &queue_id).await
        }
        ControlCommand::CreateQueue { name, task_id } => {
            crate::daemon::routes::queues::create_queue_service(state, &name, task_id.as_deref())
        }
        ControlCommand::UpdateQueue { queue_id, queue } => {
            crate::daemon::routes::queues::update_queue_service(state, &queue_id, queue)
        }
        ControlCommand::DeleteQueue { queue_id } => {
            crate::daemon::routes::queues::delete_queue_service(state, &queue_id)
        }
        ControlCommand::ReorderQueues { queue_ids } => {
            crate::daemon::routes::queues::reorder_queues_service(state, queue_ids)
        }
        ControlCommand::ReorderQueueTasks { queue_id, task_ids } => {
            crate::daemon::routes::queues::reorder_queue_tasks_service(state, &queue_id, task_ids)
        }
        ControlCommand::SetActiveProfile { profile_id } => {
            if state.profile_manager.get_profile(&profile_id).is_none() {
                return Err(StructuredError::new(
                    "not_found",
                    "Profile was not found.",
                    404,
                    false,
                ));
            }
            if !state.profile_manager.set_active(&profile_id) {
                return Err(StructuredError::new(
                    "profile_store_unavailable",
                    "The profile store could not activate the requested profile.",
                    503,
                    true,
                ));
            }
            activate_runtime_profile(state);
            Ok(serde_json::json!({"ok": true, "profile_id": profile_id}))
        }
        ControlCommand::UpsertProfile { request } => {
            let profile =
                decode_request::<crate::daemon::engine::profiles::DownloadProfile>(request)?;
            let profile_id = profile.id.clone();
            state
                .profile_manager
                .try_add_profile(profile)
                .map_err(profile_write_error)?;
            if state.profile_manager.active_profile().id == profile_id {
                activate_runtime_profile(state);
            }
            Ok(serde_json::json!({"ok": true, "profile_id": profile_id}))
        }
        ControlCommand::DeleteProfile { profile_id } => {
            let removed_active_profile = state
                .profile_manager
                .remove_profile_checked(&profile_id)
                .map_err(|error| match error {
                    crate::daemon::engine::profiles::ProfileRemovalError::BuiltinProfile => {
                        StructuredError::new(
                            "reserved_profile_id",
                            "Built-in profiles cannot be removed.",
                            409,
                            false,
                        )
                    }
                    crate::daemon::engine::profiles::ProfileRemovalError::NotFound => {
                        StructuredError::new("not_found", "Profile was not found.", 404, false)
                    }
                    crate::daemon::engine::profiles::ProfileRemovalError::StoreUnavailable => {
                        StructuredError::new(
                            "profile_store_unavailable",
                            "The profile store could not remove the profile.",
                            503,
                            true,
                        )
                    }
                })?;
            if removed_active_profile.is_some() {
                activate_runtime_profile(state);
            }
            Ok(serde_json::json!({"ok": true, "profile_id": profile_id}))
        }
        ControlCommand::AddRule { request } => {
            let rule = decode_request::<crate::daemon::engine::rules::DownloadRule>(request)?;
            let rule_id = rule.id.clone();
            match state.rule_engine.try_add_rule(rule) {
                Ok(()) => Ok(serde_json::json!({"ok": true, "rule_id": rule_id})),
                Err(error) => Err(rule_validation_error(error)),
            }
        }
        ControlCommand::DeleteRule { rule_id } => {
            let removed = state.rule_engine.try_remove_rule(&rule_id).map_err(|_| {
                StructuredError::new(
                    "rule_store_unavailable",
                    "The rule store could not remove the requested rule.",
                    503,
                    true,
                )
            })?;
            Ok(serde_json::json!({"ok": true, "rule_id": rule_id, "removed": removed}))
        }
        ControlCommand::AddSchedule { request } => {
            let rule = decode_request::<crate::daemon::engine::scheduler::SchedulerRule>(request)?;
            let schedule_id = rule.id.clone();
            state
                .scheduler
                .try_add_rule(rule)
                .map_err(scheduler_rule_error)?;
            Ok(serde_json::json!({"ok": true, "rule_id": schedule_id}))
        }
        ControlCommand::UpdateSchedule { request } => {
            let rule = decode_request::<crate::daemon::engine::scheduler::SchedulerRule>(request)?;
            let schedule_id = rule.id.clone();
            state
                .scheduler
                .try_update_rule(rule)
                .map_err(scheduler_rule_error)?;
            Ok(serde_json::json!({"ok": true, "rule_id": schedule_id}))
        }
        ControlCommand::DeleteSchedule { schedule_id } => {
            let removed = state
                .scheduler
                .try_remove_rule(&schedule_id)
                .map_err(scheduler_rule_error)?;
            Ok(serde_json::json!({"ok": true, "rule_id": schedule_id, "removed": removed}))
        }
        ControlCommand::SetSchedulerPowerCommands { enabled } => {
            state.scheduler.set_power_commands_enabled(enabled);
            Ok(serde_json::json!({
                "ok": true,
                "powerCommandsEnabled": state.scheduler.power_commands_enabled(),
            }))
        }
        ControlCommand::SetTaskPriority { task_id, priority } => {
            if crate::daemon::curl::get_task(state, &task_id).is_none() {
                return Err(StructuredError::new(
                    "not_found",
                    "Task was not found.",
                    404,
                    false,
                ));
            }
            Ok(crate::daemon::routes::engine::set_task_priority(
                state, &task_id, priority,
            ))
        }
        ControlCommand::Batch { .. } => Err(StructuredError::new(
            "nested_batch_not_allowed",
            "A batch command cannot be nested.",
            400,
            false,
        )),
    }
}

fn require_runtime_capability(
    state: &SharedState,
    capability_id: &str,
) -> Result<(), StructuredError> {
    let capabilities = state.engine_capabilities();
    let status = capabilities
        .pointer("/capabilityRegistry/entries")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(capability_id))
        })
        .and_then(|entry| entry.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unavailable");
    if status == "supported" {
        Ok(())
    } else {
        Err(StructuredError::new(
            "runtime_capability_unavailable",
            format!("Runtime capability `{capability_id}` is {status}."),
            503,
            false,
        ))
    }
}

fn control_event(
    event: crate::daemon::engine::event_bus::TimestampedEvent,
    api_token: &str,
) -> Result<ControlEvent, StructuredError> {
    use crate::daemon::engine::event_bus::EngineEvent as E;

    let (event_type, task_id) = match &event.event {
        E::DownloadStarted { task_id, .. } => ("download.started", task_id),
        E::DownloadProgress { task_id, .. } => ("download.progress", task_id),
        E::DownloadComplete { task_id, .. } => ("download.completed", task_id),
        E::DownloadFailed {
            task_id,
            will_retry,
            ..
        } => (
            if *will_retry {
                "download.retrying"
            } else {
                "download.failed"
            },
            task_id,
        ),
        E::DownloadPaused { task_id, .. } => ("download.paused", task_id),
        E::DownloadResumed { task_id, .. } => ("download.resumed", task_id),
        E::DownloadCancelled { task_id } => ("download.cancelled", task_id),
        E::SegmentStolen { task_id, .. } => ("download.segment_stolen", task_id),
        E::ConnectionsAdjusted { task_id, .. } => ("download.connections_adjusted", task_id),
        E::RetryScheduled { task_id, .. } => ("download.retry_scheduled", task_id),
        E::ChecksumVerified { task_id, .. } => ("download.checksum_verified", task_id),
        E::MirrorFound { task_id, .. } => ("download.mirror_found", task_id),
        E::SpeedChanged { task_id, .. } => ("download.speed_changed", task_id),
        E::QueueChanged { task_id, .. } => ("queue.changed", task_id),
        E::BandwidthAllocated { task_id, .. } => ("download.bandwidth_allocated", task_id),
        E::SchedulerTriggered { task_id, .. } => ("scheduler.triggered", task_id),
        E::RuleApplied { task_id, .. } => ("rule.applied", task_id),
        E::ProfileSwitched { task_id, .. } => ("profile.switched", task_id),
    };
    let serialized = serde_json::to_value(&event.event).map_err(|error| {
        StructuredError::new(
            "event_encoding_failed",
            format!("Runtime event could not be serialized: {error}"),
            500,
            false,
        )
    })?;
    let mut data = serialized.get("data").cloned().unwrap_or(Value::Null);
    redact_event_data(&mut data, None, api_token);

    Ok(ControlEvent {
        schema_version: CONTROL_EVENT_SCHEMA_VERSION,
        event_id: event.id,
        event_type: event_type.to_owned(),
        task_id: Some(task_id.clone()),
        timestamp_millis: event.timestamp_millis,
        data,
    })
}

pub(crate) fn redact_event_data(value: &mut Value, field_name: Option<&str>, api_token: &str) {
    match value {
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                let normalized = key.to_ascii_lowercase();
                let sensitive = [
                    "token",
                    "authorization",
                    "password",
                    "cookie",
                    "secret",
                    "credential",
                ]
                .iter()
                .any(|marker| normalized.contains(marker));
                if sensitive {
                    *child = Value::String("[redacted]".to_owned());
                } else {
                    redact_event_data(child, Some(key), api_token);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                redact_event_data(item, field_name, api_token);
            }
        }
        Value::String(text) => {
            let is_url = field_name.is_some_and(|name| {
                let name = name.to_ascii_lowercase();
                name == "url" || name.ends_with("url")
            });
            *text = if is_url {
                redact_event_url(text)
            } else {
                redact_inline_sensitive_text(text, api_token)
            };
        }
        _ => {}
    }
}

fn redact_event_url(raw: &str) -> String {
    let Ok(mut url) = reqwest::Url::parse(raw) else {
        return "[redacted-url]".to_owned();
    };
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);
    url.to_string()
}

fn redact_inline_sensitive_text(raw: &str, api_token: &str) -> String {
    let source = if api_token.is_empty() {
        raw.to_owned()
    } else {
        raw.replace(api_token, "[redacted]")
    };
    let mut source = redact_sensitive_fragments(&source);
    let mut output = String::with_capacity(source.len());
    loop {
        let http = source.find("http://");
        let https = source.find("https://");
        let Some(start) = http.into_iter().chain(https).min() else {
            output.push_str(&source);
            break;
        };
        output.push_str(&source[..start]);
        let url_end = source[start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')
            })
            .map(|offset| start + offset)
            .unwrap_or(source.len());
        let mut candidate_end = url_end;
        while candidate_end > start
            && source[..candidate_end]
                .chars()
                .next_back()
                .is_some_and(|character| {
                    matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}')
                })
        {
            candidate_end -= source[..candidate_end]
                .chars()
                .next_back()
                .unwrap()
                .len_utf8();
        }
        let safe = redact_event_url(&source[start..candidate_end]);
        output.push_str(&safe);
        output.push_str(&source[candidate_end..url_end]);
        source = source[url_end..].to_owned();
    }
    output
}

fn redact_sensitive_fragments(raw: &str) -> String {
    const MARKERS: &[&str] = &[
        "authorization:",
        "authorization=",
        "proxy-authorization:",
        "proxy-authorization=",
        "password:",
        "password=",
        "passwd:",
        "passwd=",
        "api_key=",
        "api_key:",
        "api-key=",
        "api-key:",
        "access_token=",
        "refresh_token=",
        "secret:",
        "secret=",
        "credential:",
        "credential=",
        "cookie:",
        "cookie=",
        "set-cookie:",
        "bearer ",
    ];
    let lower = raw.to_ascii_lowercase();
    let mut result = String::with_capacity(raw.len());
    let mut cursor = 0;

    while cursor < raw.len() {
        let next = MARKERS
            .iter()
            .filter_map(|marker| {
                lower[cursor..]
                    .find(marker)
                    .map(|offset| (cursor + offset, *marker))
            })
            .min_by_key(|(offset, _)| *offset);
        let Some((marker_start, marker)) = next else {
            result.push_str(&raw[cursor..]);
            break;
        };
        result.push_str(&raw[cursor..marker_start + marker.len()]);
        let mut value_start = marker_start + marker.len();
        while value_start < raw.len()
            && raw[value_start..]
                .chars()
                .next()
                .is_some_and(char::is_whitespace)
        {
            let whitespace = raw[value_start..].chars().next().unwrap();
            result.push(whitespace);
            value_start += whitespace.len_utf8();
        }
        result.push_str("[redacted]");
        let redact_rest_of_line = matches!(
            marker,
            "authorization:"
                | "authorization="
                | "proxy-authorization:"
                | "proxy-authorization="
                | "cookie:"
                | "cookie="
                | "set-cookie:"
                | "set-cookie="
                | "bearer "
        );
        let value_end = if redact_rest_of_line {
            raw[value_start..]
                .find('\n')
                .map(|offset| value_start + offset)
                .unwrap_or(raw.len())
        } else {
            raw[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')
                })
                .map(|offset| value_start + offset)
                .unwrap_or(raw.len())
        };
        cursor = value_end.max(value_start);
        if cursor == raw.len() {
            break;
        }
    }

    result
}

fn domain_error(message: String) -> StructuredError {
    let normalized = message.to_ascii_lowercase();
    let status = if normalized.contains("not found") {
        404
    } else if normalized.contains("already")
        || normalized.contains("cannot")
        || normalized.contains("completed")
        || normalized.contains("active")
    {
        409
    } else {
        422
    };
    let code = match status {
        404 => "not_found",
        409 => "conflict",
        _ => "command_rejected",
    };
    StructuredError::new(code, message, status, false)
}

fn activate_runtime_profile(state: &SharedState) {
    let profile = state.profile_manager.active_profile();
    // Apply retry and bandwidth defaults together whenever the active profile
    // changes, including when deleting the active custom profile falls back to
    // the built-in balanced profile.
    if let Ok(mut policy) = state.default_retry_policy.write() {
        *policy = profile.to_retry_policy();
    }
    let kbps = profile.rate_limit_kbps.unwrap_or(0);
    state.bandwidth_manager.set_global_limit(kbps);
    state.priority_queue.set_total_bandwidth(kbps);
    state.event_bus.publish(
        crate::daemon::engine::event_bus::EngineEvent::ProfileSwitched {
            task_id: "global".to_owned(),
            profile: profile.name.clone(),
        },
    );
}

fn profile_write_error(
    error: crate::daemon::engine::profiles::ProfileWriteError,
) -> StructuredError {
    use crate::daemon::engine::profiles::ProfileWriteError as E;

    match error {
        E::InvalidId => StructuredError::new(
            "invalid_profile_id",
            "Profile id must be non-empty, at most 128 bytes, and contain no control characters.",
            400,
            false,
        ),
        E::InvalidName => StructuredError::new(
            "invalid_profile_name",
            "Profile name must be non-empty, at most 160 bytes, and contain no control characters.",
            422,
            false,
        ),
        E::InvalidDescription => StructuredError::new(
            "invalid_profile_description",
            "Profile description cannot exceed 4096 bytes or contain control characters.",
            422,
            false,
        ),
        E::InvalidConnections => StructuredError::new(
            "invalid_profile_connections",
            "Profile connection bounds require 1 <= default <= maximum <= 512.",
            422,
            false,
        ),
        E::InvalidAdaptiveThresholds => StructuredError::new(
            "invalid_profile_thresholds",
            "Adaptive speed thresholds must be finite and non-negative.",
            422,
            false,
        ),
        E::InvalidRetryPolicy => StructuredError::new(
            "invalid_profile_retry_policy",
            "Retry policy must use at most 100 retries, delays within 1 hour/24 hours, base <= maximum, and backoff from 1 to 10.",
            422,
            false,
        ),
        E::InvalidSegmentSize => StructuredError::new(
            "invalid_profile_segment_size",
            "A configured segment size must be greater than zero.",
            422,
            false,
        ),
        E::BuiltinProfile => StructuredError::new(
            "reserved_profile_id",
            "Built-in profile ids are reserved.",
            409,
            false,
        ),
        E::StoreUnavailable => StructuredError::new(
            "profile_store_unavailable",
            "The profile store could not save the profile.",
            503,
            true,
        ),
    }
}

fn rule_validation_error(message: String) -> StructuredError {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("already exists") {
        StructuredError::new(
            "rule_already_exists",
            "A rule with this id already exists.",
            409,
            false,
        )
    } else if normalized.contains("lock poisoned") {
        StructuredError::new(
            "rule_store_unavailable",
            "The rule store is unavailable.",
            503,
            true,
        )
    } else {
        StructuredError::new("invalid_rule", message, 422, false)
    }
}

fn scheduler_rule_error(
    error: crate::daemon::engine::scheduler::SchedulerRuleError,
) -> StructuredError {
    use crate::daemon::engine::scheduler::SchedulerRuleError as E;

    match error {
        E::InvalidId => StructuredError::new(
            "invalid_schedule_id",
            "Schedule id must be non-empty, at most 128 bytes, and contain no control characters.",
            400,
            false,
        ),
        E::InvalidName => StructuredError::new(
            "invalid_schedule_name",
            "Schedule name must be non-empty, at most 160 bytes, and contain no control characters.",
            400,
            false,
        ),
        E::InvalidTimeWindow => StructuredError::new(
            "invalid_schedule_time",
            "Schedule time windows require hours from 0 to 23 and minutes from 0 to 59.",
            422,
            false,
        ),
        E::AlreadyExists => StructuredError::new(
            "schedule_already_exists",
            "A schedule with this id already exists.",
            409,
            false,
        ),
        E::NotFound => StructuredError::new(
            "not_found",
            "Schedule was not found.",
            404,
            false,
        ),
        E::LockUnavailable => StructuredError::new(
            "scheduler_unavailable",
            "The scheduler could not access its rule store.",
            503,
            true,
        ),
    }
}

fn decode_request<T: serde::de::DeserializeOwned>(request: Value) -> Result<T, StructuredError> {
    serde_json::from_value(request).map_err(|error| {
        StructuredError::new(
            "invalid_command_payload",
            format!("Command payload does not match the download contract: {error}"),
            400,
            false,
        )
    })
}

fn to_value<T: Serialize>(value: T) -> Result<Value, StructuredError> {
    serde_json::to_value(value).map_err(|error| {
        StructuredError::new(
            "command_result_encoding_failed",
            format!("Command result could not be serialized: {error}"),
            500,
            false,
        )
    })
}

fn route_error(state: &SharedState, status: StatusCode, body: Value) -> StructuredError {
    let raw_message = body
        .get("error")
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("The command was rejected by the runtime.");
    let message = if state.api_token.is_empty() {
        raw_message.to_owned()
    } else {
        raw_message.replace(&state.api_token, "[redacted]")
    };
    let code = if status == StatusCode::UNAUTHORIZED {
        "unauthorized"
    } else if status == StatusCode::FORBIDDEN {
        "permission_denied"
    } else if status == StatusCode::NOT_FOUND {
        "not_found"
    } else if status == StatusCode::CONFLICT {
        "conflict"
    } else if status == StatusCode::TOO_MANY_REQUESTS {
        "rate_limited"
    } else if status.is_client_error() {
        "command_rejected"
    } else {
        "command_failed"
    };
    StructuredError::new(code, message, status.as_u16(), status.is_server_error())
}
