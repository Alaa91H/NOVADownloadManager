use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use log::LevelFilter;
use serde::Deserialize;

use crate::daemon::state::SharedState;

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/logs", get(handle_recent_logs))
        .route(
            "/api/logs/level",
            get(handle_get_log_level).patch(handle_set_log_level),
        )
        .route("/api/logs/file", get(handle_log_file))
        .route("/api/logs/tasks", get(handle_log_tasks))
        .route("/api/logs/trace", get(handle_log_trace))
}

#[derive(Debug, Deserialize)]
struct RecentLogsQuery {
    /// Maximum number of entries to return (clamped to the ring buffer size).
    limit: Option<usize>,
    /// Only return entries at or above this level (trace|debug|info|warn|error).
    level: Option<String>,
}

async fn handle_recent_logs(
    Query(params): Query<RecentLogsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let min_level = match params.level.as_deref() {
        None => None,
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "trace" => Some(LevelFilter::Trace),
            "debug" => Some(LevelFilter::Debug),
            "info" => Some(LevelFilter::Info),
            "warn" => Some(LevelFilter::Warn),
            "error" => Some(LevelFilter::Error),
            other => {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": format!("invalid level filter: {other}")})),
                ));
            }
        },
    };
    let limit = params
        .limit
        .unwrap_or(500)
        .min(crate::logging::LOG_BUFFER_CAPACITY);
    let entries = crate::logging::recent(limit, min_level);
    Ok(Json(serde_json::json!({
        "entries": entries,
        "level": crate::logging::current_level().to_string().to_ascii_lowercase(),
        "logDir": crate::logging::log_dir(),
    })))
}

async fn handle_get_log_level() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "level": crate::logging::current_level().to_string().to_ascii_lowercase(),
    }))
}

#[derive(Debug, Deserialize)]
struct SetLogLevelBody {
    level: String,
}

async fn handle_set_log_level(
    Json(body): Json<SetLogLevelBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let level = match body.level.trim().to_ascii_lowercase().as_str() {
        "off" => LevelFilter::Off,
        "error" => LevelFilter::Error,
        "warn" => LevelFilter::Warn,
        "info" => LevelFilter::Info,
        "debug" => LevelFilter::Debug,
        "trace" => LevelFilter::Trace,
        other => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("invalid level: {other}")})),
            ));
        }
    };
    crate::logging::set_level(level).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
    })?;
    Ok(Json(serde_json::json!({
        "level": level.to_string().to_ascii_lowercase(),
    })))
}

#[derive(Debug, Deserialize)]
struct LogFileQuery {
    /// Base name of the log file (defaults to the active `nova.log`).
    file: Option<String>,
    /// Number of trailing lines to return (clamped to [0, 5000]).
    lines: Option<usize>,
    /// Case-insensitive substring to grep for (with surrounding context).
    grep: Option<String>,
    /// Number of context lines around each grep hit (clamped to [0, 25]).
    context: Option<usize>,
    /// Maximum number of grep hits (clamped to [1, 500]).
    #[serde(rename = "maxMatches")]
    max_matches: Option<usize>,
}

async fn handle_log_file(
    Query(params): Query<LogFileQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let lines = params.lines.unwrap_or(200).min(5000);
    let context_lines = params.context.unwrap_or(3).min(25);
    let max_matches = params.max_matches.unwrap_or(100).clamp(1, 500);

    let files = crate::logging::log_files();
    let names: Vec<String> = files.iter().map(|(name, _)| name.clone()).collect();
    let active = names
        .iter()
        .find(|name| name.as_str() == "nova.log")
        .cloned()
        .unwrap_or_else(|| names.first().cloned().unwrap_or_default());

    let file = params.file.as_deref().filter(|f| !f.is_empty());
    let tail = crate::logging::read_log_file(
        file,
        lines,
        params.grep.as_deref(),
        context_lines,
        max_matches,
    );

    match tail {
        Some(tail) => Ok(Json(serde_json::json!({
            "files": names,
            "active": active,
            "file": tail.path.rsplit(['/', '\\']).next().unwrap_or_default(),
            "path": tail.path,
            "totalLines": tail.total_lines,
            "linesRead": tail.tail.len(),
            "tail": tail.tail,
            "matches": tail.matches,
            "truncatedMatches": tail.truncated_matches,
            "logDir": crate::logging::log_dir(),
        }))),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({
                "error": format!(
                    "log file not found: {} (available: {})",
                    file.unwrap_or("nova.log"),
                    if names.is_empty() {
                        "<none>".to_owned()
                    } else {
                        names.join(", ")
                    }
                )
            })),
        )),
    }
}

/// Per-task summaries aggregated from the ring buffer, newest activity first.
async fn handle_log_tasks() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "tasks": crate::logging::task_summaries(),
    }))
}

#[derive(Debug, Deserialize)]
struct LogTraceQuery {
    /// Task id to reconstruct the trail for.
    task: String,
    /// Maximum number of matching records to return (clamped to [1, 5000]).
    limit: Option<usize>,
}

async fn handle_log_trace(
    Query(params): Query<LogTraceQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let task_id = params.task.trim();
    if task_id.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "task query parameter must not be empty"})),
        ));
    }
    let limit = params.limit.unwrap_or(2000).clamp(1, 5000);
    let trace = crate::logging::task_trace(task_id, limit);
    Ok(Json(serde_json::json!({
        "trace": trace,
    })))
}
