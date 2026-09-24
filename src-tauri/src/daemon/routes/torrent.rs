use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::{get, patch, post};
use axum::Router;

use crate::daemon::state::SharedState;
use crate::daemon::torrent_task::{
    analyze_magnet, create_torrent_task, reauthorize_torrent_task, torrent_task_details,
    update_torrent_file_priorities, AnalyzeTorrentBody, CreateTorrentBody,
    ReauthorizeTorrentBody, TorrentAnalysisView, TorrentTaskDetails, UpdateTorrentFilesBody,
};
use crate::daemon::types::Task;

type ApiError = (StatusCode, Json<serde_json::Value>);

fn torrent_error(message: String) -> ApiError {
    let lower = message.to_ascii_lowercase();
    let status = if lower.contains("not found") || lower.contains("expired") {
        StatusCode::NOT_FOUND
    } else if lower.contains("already active") || lower.contains("pause the torrent") {
        StatusCode::CONFLICT
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    (status, Json(serde_json::json!({ "error": message })))
}

async fn handle_analyze_torrent(
    State(state): State<SharedState>,
    Json(body): Json<AnalyzeTorrentBody>,
) -> Result<Json<TorrentAnalysisView>, ApiError> {
    analyze_magnet(&state, &body.magnet_uri)
        .await
        .map(Json)
        .map_err(torrent_error)
}

async fn handle_create_torrent(
    State(state): State<SharedState>,
    Json(body): Json<CreateTorrentBody>,
) -> Result<Json<Task>, ApiError> {
    create_torrent_task(&state, body)
        .await
        .map(Json)
        .map_err(torrent_error)
}

async fn handle_torrent_details(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> Result<Json<TorrentTaskDetails>, ApiError> {
    torrent_task_details(&state, &id)
        .await
        .map(Json)
        .map_err(torrent_error)
}

async fn handle_update_torrent_files(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateTorrentFilesBody>,
) -> Result<Json<TorrentTaskDetails>, ApiError> {
    update_torrent_file_priorities(&state, &id, body.file_priorities)
        .await
        .map(Json)
        .map_err(torrent_error)
}

async fn handle_reauthorize_torrent(
    State(state): State<SharedState>,
    Path(id): Path<String>,
    Json(body): Json<ReauthorizeTorrentBody>,
) -> Result<Json<Task>, ApiError> {
    reauthorize_torrent_task(&state, &id, &body.magnet_uri)
        .await
        .map(Json)
        .map_err(torrent_error)
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router
        .route("/api/torrents/analyze", post(handle_analyze_torrent))
        .route("/api/torrents", post(handle_create_torrent))
        .route("/api/torrents/{id}", get(handle_torrent_details))
        .route(
            "/api/torrents/{id}/files",
            patch(handle_update_torrent_files),
        )
        .route(
            "/api/torrents/{id}/reauthorize",
            post(handle_reauthorize_torrent),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn torrent_api_error_classifies_expiry_and_active_conflict() {
        assert_eq!(
            torrent_error("Torrent analysis expired or was not found".to_owned()).0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            torrent_error("Torrent task is already active".to_owned()).0,
            StatusCode::CONFLICT
        );
        assert_eq!(
            torrent_error("Invalid torrent selection".to_owned()).0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
