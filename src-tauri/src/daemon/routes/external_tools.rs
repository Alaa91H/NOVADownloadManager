use crate::daemon::external_tools::types::ToolId;
use crate::daemon::state::SharedState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/external-tools", get(handle_list_tools))
        .route("/api/external-tools/{tool_id}", get(handle_get_tool))
        .route(
            "/api/external-tools/{tool_id}/discover",
            post(handle_discover),
        )
        .route(
            "/api/external-tools/{tool_id}/health",
            post(handle_health_check),
        )
        .route(
            "/api/external-tools/{tool_id}/check-updates",
            post(handle_check_updates),
        )
        .route("/api/external-tools/{tool_id}/update", post(handle_update))
        .route(
            "/api/external-tools/{tool_id}/set-path",
            post(handle_set_path),
        )
        .route(
            "/api/external-tools/{tool_id}/uninstall",
            post(handle_uninstall),
        )
        .route(
            "/api/external-tools/capabilities/{capability_id}",
            get(handle_check_capability),
        )
        .route("/api/external-tools/health", get(handle_health_all))
}

async fn handle_list_tools(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let manager = state.external_tools.lock().unwrap();
    let tool_states = manager.all_tool_states();
    drop(manager);

    Json(serde_json::json!({
        "tools": tool_states,
    }))
}

async fn handle_get_tool(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    let tool_state = manager.tool_state(id);
    drop(manager);

    Ok(Json(serde_json::json!(tool_state)))
}

async fn handle_discover(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    let installation = manager.discover(id);
    drop(manager);

    Ok(Json(serde_json::json!({
        "ok": true,
        "status": installation.status.display_text(),
        "version": installation.version.as_ref().map(|v| v.to_string()),
        "path": installation.path.as_ref().map(|p| p.display().to_string()),
        "capabilities": installation.capabilities.iter().map(|c| &c.id).collect::<Vec<_>>(),
    })))
}

async fn handle_health_check(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    let installation = manager.check_health(id);
    drop(manager);

    Ok(Json(serde_json::json!({
        "ok": installation.health_ok,
        "status": installation.status.display_text(),
        "error": installation.error_message,
    })))
}

async fn handle_check_updates(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    let update_info = manager.check_for_updates(id);
    drop(manager);

    Ok(Json(serde_json::json!({
        "available": update_info.available,
        "latestVersion": update_info.latest_version,
        "downloadUrl": update_info.download_url,
        "releaseNotes": update_info.release_notes,
        "publishedAt": update_info.published_at,
    })))
}

async fn handle_update(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    match manager.update(id) {
        Ok(path) => {
            let installation = manager.discover(id);
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": true,
                "path": path,
                "status": installation.status.display_text(),
            })))
        }
        Err(e) => {
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": false,
                "error": e,
            })))
        }
    }
}

async fn handle_set_path(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let path = body.get("path").and_then(|v| v.as_str()).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Missing 'path' field"})),
        )
    })?;

    let manager = state.external_tools.lock().unwrap();
    match manager.set_custom_path(id, path) {
        Ok(installation) => {
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": true,
                "status": installation.status.display_text(),
                "version": installation.version.as_ref().map(|v| v.to_string()),
                "path": installation.path.as_ref().map(|p| p.display().to_string()),
            })))
        }
        Err(e) => {
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": false,
                "error": e,
            })))
        }
    }
}

async fn handle_uninstall(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.lock().unwrap();
    match manager.uninstall(id) {
        Ok(()) => {
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": true,
            })))
        }
        Err(e) => {
            drop(manager);
            Ok(Json(serde_json::json!({
                "ok": false,
                "error": e,
            })))
        }
    }
}

async fn handle_check_capability(
    State(state): State<SharedState>,
    Path(capability_id): Path<String>,
) -> Json<serde_json::Value> {
    let manager = state.external_tools.lock().unwrap();
    let availability = manager.resolve_capability(&capability_id);
    drop(manager);

    Json(serde_json::json!({
        "capabilityId": availability.capability_id,
        "available": availability.available,
        "toolId": availability.tool_id.as_str(),
        "requiresMessage": availability.requires_message,
    }))
}

async fn handle_health_all(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let manager = state.external_tools.lock().unwrap();
    let installations = manager.discover_all();
    drop(manager);

    let results: Vec<serde_json::Value> = installations
        .iter()
        .map(|inst| {
            serde_json::json!({
                "toolId": inst.tool_id.as_str(),
                "status": inst.status.display_text(),
                "healthy": inst.health_ok,
                "version": inst.version.as_ref().map(|v| v.to_string()),
            })
        })
        .collect();

    Json(serde_json::json!({
        "tools": results,
    }))
}

fn parse_tool_id(id: &str) -> Result<ToolId, (StatusCode, Json<serde_json::Value>)> {
    match id {
        "ffmpeg" | "FFmpeg" => Ok(ToolId::Ffmpeg),
        "yt-dlp" | "ytdlp" | "yt_dlp" => Ok(ToolId::YtDlp),
        _ => Err((
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Unknown tool: {}", id)})),
        )),
    }
}
