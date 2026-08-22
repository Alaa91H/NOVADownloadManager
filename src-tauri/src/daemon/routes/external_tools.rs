use crate::daemon::external_tools::types::{InstallScope, ToolId};
use crate::daemon::state::SharedState;
use crate::lock_or_err;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};

#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    #[serde(default)]
    scope: InstallScope,
}

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
        .route(
            "/api/external-tools/{tool_id}/install",
            post(handle_install),
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

fn external_tool_worker_error(
    operation: &str,
    error: tokio::task::JoinError,
) -> (StatusCode, Json<serde_json::Value>) {
    log::error!("External-tool {operation} worker failed: {error}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": "External-tool worker failed"})),
    )
}

async fn handle_list_tools(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let manager = state.external_tools.clone();
    let tool_states = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.all_tool_states()
    })
    .await
    .map_err(|error| external_tool_worker_error("list", error))?;

    Ok(Json(serde_json::json!({
        "tools": tool_states,
    })))
}

async fn handle_get_tool(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.clone();
    let tool_state = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.tool_state(id)
    })
    .await
    .map_err(|error| external_tool_worker_error("details", error))?;

    Ok(Json(serde_json::json!(tool_state)))
}

async fn handle_discover(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.clone();
    let installation = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.discover(id)
    })
    .await
    .map_err(|error| external_tool_worker_error("discovery", error))?;

    Ok(Json(serde_json::json!({
        "ok": true,
        "status": installation.status.display_text(),
        "version": installation.version.as_ref().map(std::string::ToString::to_string),
        "path": installation.path.as_ref().map(|p| p.display().to_string()),
        "capabilities": installation.capabilities.iter().map(|c| &c.id).collect::<Vec<_>>(),
    })))
}

async fn handle_health_check(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.clone();
    let installation = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.check_health(id)
    })
    .await
    .map_err(|error| external_tool_worker_error("health check", error))?;

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
    let manager = state.external_tools.clone();
    let update_info = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.check_for_updates(id)
    })
    .await
    .map_err(|error| external_tool_worker_error("update check", error))?;

    Ok(Json(serde_json::json!({
        "available": update_info.available,
        "latestVersion": update_info.latest_version,
        "downloadUrl": update_info.download_url,
        "releaseNotes": update_info.release_notes,
        "publishedAt": update_info.published_at,
    })))
}

async fn handle_install(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
    body: Option<Json<InstallRequest>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let scope = body.map(|Json(request)| request.scope).unwrap_or_default();
    let manager = state.external_tools.clone();
    let install_result = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.install_in_scope(id, scope)
    })
    .await
    .map_err(|error| {
        log::error!("External-tool install worker panicked: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "External-tool install worker failed"})),
        )
    })?;

    match install_result {
        Ok(path) => {
            state
                .activate_external_tool(id, path.clone())
                .map_err(|error| {
                    log::error!("Installed external tool could not be activated: {error}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": error})),
                    )
                })?;
            Ok(Json(serde_json::json!({
                "ok": true,
                "path": path,
                "status": "Installed",
                "scope": scope,
            })))
        }
        Err(error) => Ok(Json(serde_json::json!({
            "ok": false,
            "error": error,
            "scope": scope,
        }))),
    }
}

async fn handle_update(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.clone();
    let update_result = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.update(id)
    })
    .await
    .map_err(|error| {
        log::error!("External-tool update worker panicked: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "External-tool update worker failed"})),
        )
    })?;

    match update_result {
        Ok(path) => {
            state
                .activate_external_tool(id, path.clone())
                .map_err(|error| {
                    log::error!("Updated external tool could not be activated: {error}");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": error})),
                    )
                })?;
            Ok(Json(serde_json::json!({
                "ok": true,
                "path": path,
                "status": "Installed",
            })))
        }
        Err(error) => Ok(Json(serde_json::json!({
            "ok": false,
            "error": error,
        }))),
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

    // Validate the path exists and points to a real file (not a directory or broken symlink).
    let p = std::path::Path::new(path);
    match p.canonicalize() {
        Ok(canonical) => {
            if !canonical.is_file() {
                return Err((
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "Path does not point to a file"})),
                ));
            }
        }
        Err(_) => {
            return Err((
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Path does not exist or is not accessible"})),
            ));
        }
    }

    let manager = state.external_tools.clone();
    let path = path.to_owned();
    let set_path_result = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.set_custom_path(id, &path)
    })
    .await
    .map_err(|error| external_tool_worker_error("set path", error))?;

    match set_path_result {
        Ok(installation) => Ok(Json(serde_json::json!({
            "ok": true,
            "status": installation.status.display_text(),
            "version": installation.version.as_ref().map(std::string::ToString::to_string),
            "path": installation.path.as_ref().map(|p| p.display().to_string()),
        }))),
        Err(error) => Ok(Json(serde_json::json!({
            "ok": false,
            "error": error,
        }))),
    }
}

async fn handle_uninstall(
    State(state): State<SharedState>,
    Path(tool_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let id = parse_tool_id(&tool_id)?;
    let manager = state.external_tools.clone();
    let uninstall_result = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.uninstall(id)
    })
    .await
    .map_err(|error| {
        log::error!("External-tool uninstall worker panicked: {error}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "External-tool uninstall worker failed"})),
        )
    })?;

    match uninstall_result {
        Ok(()) => {
            state.deactivate_external_tool(id).map_err(|error| {
                log::error!("Uninstalled external tool could not be deactivated: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": error})),
                )
            })?;
            Ok(Json(serde_json::json!({"ok": true})))
        }
        Err(error) => Ok(Json(serde_json::json!({"ok": false, "error": error}))),
    }
}

async fn handle_check_capability(
    State(state): State<SharedState>,
    Path(capability_id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let manager = state.external_tools.clone();
    let availability = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.resolve_capability(&capability_id)
    })
    .await
    .map_err(|error| external_tool_worker_error("capability check", error))?;

    Ok(Json(serde_json::json!({
        "capabilityId": availability.capability_id,
        "available": availability.available,
        "toolId": availability.tool_id.as_str(),
        "requiresMessage": availability.requires_message,
    })))
}

async fn handle_health_all(
    State(state): State<SharedState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let manager = state.external_tools.clone();
    let installations = tokio::task::spawn_blocking(move || {
        let manager = lock_or_err!(manager);
        manager.discover_all()
    })
    .await
    .map_err(|error| external_tool_worker_error("health summary", error))?;

    let results: Vec<serde_json::Value> = installations
        .iter()
        .map(|inst| {
            serde_json::json!({
                "toolId": inst.tool_id.as_str(),
                "status": inst.status.display_text(),
                "healthy": inst.health_ok,
                "version": inst.version.as_ref().map(std::string::ToString::to_string),
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "tools": results,
    })))
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
