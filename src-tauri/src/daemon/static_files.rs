use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::body::Body;

use crate::daemon::state::SharedState;
use crate::daemon::utils::mime_for_path;

pub async fn serve_index(State(state): State<SharedState>) -> Result<axum::response::Response, (StatusCode, String)> {
    let path = std::path::Path::new(&state.resource_dir).join("index.html");
    let content = tokio::fs::read(&path).await.map_err(|e| {
        (StatusCode::NOT_FOUND, format!("Index not found: {}", e))
    })?;
    axum::response::Response::builder()
        .header("content-type", "text/html; charset=utf-8")
        .body(Body::from(content))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Response build error: {}", e)))
}

pub async fn serve_asset(
    State(state): State<SharedState>,
    Path(path): Path<String>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let file_path = std::path::Path::new(&state.resource_dir).join("assets").join(&path);
    let content = tokio::fs::read(&file_path).await.map_err(|_| {
        (StatusCode::NOT_FOUND, "Asset not found".to_string())
    })?;

    let mime = mime_for_path(&path);
    axum::response::Response::builder()
        .header("content-type", mime)
        .body(Body::from(content))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Response build error: {}", e)))
}

pub async fn serve_spa_fallback(
    State(state): State<SharedState>,
) -> Result<axum::response::Response, (StatusCode, String)> {
    let path = std::path::Path::new(&state.resource_dir).join("index.html");
    let content = tokio::fs::read(&path).await.map_err(|e| {
        (StatusCode::NOT_FOUND, format!("Index not found: {}", e))
    })?;
    axum::response::Response::builder()
        .header("content-type", "text/html; charset=utf-8")
        .body(Body::from(content))
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Response build error: {}", e)))
}
