use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::Json;
use reqwest::multipart::{Form, Part};
use reqwest::Body;
use serde_json;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_util::codec::{BytesCodec, FramedRead};

use crate::daemon::curl::{delete_task, list_all_tasks};
use crate::daemon::routes::{handle_pause_task, handle_resume_task};
use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;
use crate::lock_or_err;

pub async fn handle_telegram_config(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let cfg = lock_or_err!(state.telegram_config).clone();
    let masked = if cfg.token.is_empty() {
        String::new()
    } else if cfg.token.len() <= 8 {
        "****".to_string()
    } else {
        let prefix = &cfg.token[..4];
        let suffix = &cfg.token[cfg.token.len() - 4..];
        format!("{prefix}...{suffix}")
    };
    Json(serde_json::json!({
        "enabled": cfg.enabled,
        "token": masked,
        "hasToken": !cfg.token.is_empty(),
        "chatId": cfg.chat_id,
        "apiBase": cfg.api_base,
        "fileUploadLimitMb": cfg.file_upload_limit_mb,
    }))
}

pub async fn handle_telegram_update_config(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    {
        let mut cfg = lock_or_err!(state.telegram_config);
        if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) {
            cfg.enabled = v;
        }
        if let Some(v) = body.get("token").and_then(|v| v.as_str()) {
            cfg.token = v.to_string();
        }
        if let Some(v) = body.get("chatId").and_then(|v| v.as_i64()) {
            cfg.chat_id = v;
        }
        if let Some(v) = body.get("apiBase").and_then(|v| v.as_str()) {
            cfg.api_base = normalize_api_base(v);
        }
        if let Some(v) = body.get("fileUploadLimitMb").and_then(|v| v.as_u64()) {
            cfg.file_upload_limit_mb = v.clamp(1, 2000);
        }
    }
    Json(serde_json::json!({"ok": true}))
}

pub async fn handle_telegram_test(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let cfg = lock_or_err!(state.telegram_config).clone();
    if cfg.token.is_empty() {
        return Json(serde_json::json!({"ok": false, "error": "Token not set"}));
    }
    let msg = format!("NOVA Telegram Bot is working!\nChat ID: {}", cfg.chat_id);
    let ok = telegram_send_message(
        &state.http_client,
        &cfg.api_base,
        &cfg.token,
        cfg.chat_id,
        &msg,
    )
    .await;
    Json(serde_json::json!({"ok": ok}))
}

fn normalize_api_base(api_base: &str) -> String {
    let trimmed = api_base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "https://api.telegram.org".to_string()
    } else {
        trimmed.to_string()
    }
}

fn telegram_api_url(api_base: &str, token: &str, method: &str) -> String {
    format!("{}/bot{}/{}", normalize_api_base(api_base), token, method)
}

async fn telegram_send_message(
    client: &reqwest::Client,
    api_base: &str,
    token: &str,
    chat_id: i64,
    text: &str,
) -> bool {
    let url = telegram_api_url(api_base, token, "sendMessage");
    client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn blocking_client() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .build()
                .inspect_err(|e| {
                    log::error!("Failed to create blocking HTTP client for Telegram: {e}")
                })
                .ok()
        })
        .as_ref()
}

pub fn send_telegram_msg_blocking_with_api(
    api_base: &str,
    token: &str,
    chat_id: i64,
    text: &str,
) -> bool {
    let client = match blocking_client() {
        Some(c) => c,
        None => {
            log::error!("Cannot send Telegram message: HTTP client not available");
            return false;
        }
    };
    let url = telegram_api_url(api_base, token, "sendMessage");
    client
        .post(&url)
        .json(&serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

pub fn start_telegram_bot(state: SharedState) {
    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                log::error!("Failed to create tokio runtime for telegram bot: {}", e);
                return;
            }
        };
        let client = reqwest::blocking::Client::new();
        loop {
            let (token, enabled, chat_id, api_base) = {
                let cfg = lock_or_err!(state.telegram_config);
                (
                    cfg.token.clone(),
                    cfg.enabled,
                    cfg.chat_id,
                    cfg.api_base.clone(),
                )
            };
            let last_update_id = *lock_or_err!(state.telegram_last_update_id);
            if enabled && !token.is_empty() {
                let url = telegram_api_url(&api_base, &token, "getUpdates");
                if let Ok(resp) = client
                    .post(&url)
                    .json(&serde_json::json!({
                        "offset": last_update_id + 1,
                        "timeout": 30,
                        "allowed_updates": ["message"],
                    }))
                    .send()
                {
                    if let Ok(body) = resp.json::<serde_json::Value>() {
                        if let Some(updates) = body.get("result").and_then(|r| r.as_array()) {
                            for update in updates {
                                if let Some(uid) = update.get("update_id").and_then(|u| u.as_i64())
                                {
                                    {
                                        let mut lid = lock_or_err!(state.telegram_last_update_id);
                                        *lid = uid;
                                        state.mark_dirty();
                                    }
                                }
                                if let Some(msg) = update.get("message") {
                                    if let Some(text) = msg.get("text").and_then(|t| t.as_str()) {
                                        let from_chat = msg
                                            .get("chat")
                                            .and_then(|c| c.get("id"))
                                            .and_then(|i| i.as_i64())
                                            .unwrap_or(0);
                                        if from_chat != chat_id {
                                            continue;
                                        }
                                        handle_telegram_command(
                                            &state, &api_base, &token, from_chat, text, &rt,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}

fn handle_telegram_command(
    state: &SharedState,
    api_base: &str,
    token: &str,
    chat_id: i64,
    text: &str,
    rt: &tokio::runtime::Runtime,
) {
    let text = text.trim();
    if text.starts_with('/') {
        let parts: Vec<&str> = text.splitn(2, ' ').collect();
        let cmd = parts[0];
        let arg = parts.get(1).copied().unwrap_or("");

        match cmd {
            "/start" | "/help" => {
                let help = "NOVA Bot Commands:\n".to_string()
                    + "/list - List all downloads\n"
                    + "/add <url> - Add download\n"
                    + "/pause <id> - Pause download\n"
                    + "/resume <id> - Resume download\n"
                    + "/delete <id> - Delete download\n"
                    + "/help - Show this help";
                send_telegram_msg_blocking_with_api(api_base, token, chat_id, &help);
            }
            "/list" => {
                let tasks = rt.block_on(list_all_tasks(state));
                if tasks.is_empty() {
                    send_telegram_msg_blocking_with_api(api_base, token, chat_id, "No downloads.");
                } else {
                    let mut msg = format!("Downloads ({})\n\n", tasks.len());
                    for t in tasks.iter().take(20) {
                        let icon = match t.status.as_str() {
                            "downloading" => "⬇\u{fe0f}",
                            "completed" => "✅",
                            "paused" => "⏸\u{fe0f}",
                            "queued" => "⏳",
                            _ => "❌",
                        };
                        let pct = if t.size_bytes > 0 {
                            (t.downloaded_bytes as f64 / t.size_bytes as f64 * 100.0) as u64
                        } else {
                            0
                        };
                        msg.push_str(&format!(
                            "{} <code>{}</code> - {} ({}%)\n",
                            icon,
                            &t.id[..t.id.len().min(8)],
                            t.name,
                            pct
                        ));
                    }
                    if tasks.len() > 20 {
                        msg.push_str(&format!("\n... and {} more", tasks.len() - 20));
                    }
                    send_telegram_msg_blocking_with_api(api_base, token, chat_id, &msg);
                }
            }
            "/add" => {
                if arg.is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        "Usage: /add <url>",
                    );
                    return;
                }
                if let Err(e) = crate::daemon::utils::is_safe_target_url(arg) {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Blocked: {}", e),
                    );
                    return;
                }
                let body = CreateDownloadBody {
                    url: Some(arg.to_string()),
                    name: None,
                    file_type: None,
                    size_bytes: None,
                    category: None,
                    queue_id: None,
                    connections: None,
                    resumable: None,
                    save_path: None,
                    description: None,
                    referer: None,
                    start_immediately: Some(true),
                    direct_options: None,
                    media_options: None,
                };
                match rt.block_on(crate::daemon::curl::create_curl_task(state, &body)) {
                    Ok(task) => {
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Added: {}", task.name),
                        );
                    }
                    Err(e) => {
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Failed: {}", e),
                        );
                    }
                }
            }
            "/pause" | "/resume" | "/delete" => {
                if arg.is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Usage: {} <id>", cmd),
                    );
                    return;
                }
                match cmd {
                    "/pause" => {
                        let result = rt.block_on(async {
                            handle_pause_task(State(state.clone()), AxumPath(arg.to_string())).await
                        });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                &format!("Paused: {}", arg),
                            ),
                            Err(e) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                e.1 .0
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown"),
                            ),
                        };
                    }
                    "/resume" => {
                        let result = rt.block_on(async {
                            handle_resume_task(State(state.clone()), AxumPath(arg.to_string()))
                                .await
                        });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                &format!("Resumed: {}", arg),
                            ),
                            Err(e) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                e.1 .0
                                    .get("error")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown"),
                            ),
                        };
                    }
                    "/delete" => {
                        let result = rt.block_on(async { delete_task(state, arg, false).await });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                &format!("Removed from list: {}", arg),
                            ),
                            Err(e) => {
                                send_telegram_msg_blocking_with_api(api_base, token, chat_id, &e)
                            }
                        };
                    }
                    _ => {}
                }
            }
            _ => {
                send_telegram_msg_blocking_with_api(
                    api_base,
                    token,
                    chat_id,
                    &format!(
                        "Unknown command: {}\nUse /help for available commands.",
                        cmd
                    ),
                );
            }
        }
    }
}

pub async fn telegram_notify(state: &SharedState, text: &str) {
    let cfg = match state.telegram_config.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            log::error!("Mutex poisoned in telegram_notify: {}", poisoned);
            return;
        }
    };
    if cfg.enabled && !cfg.token.is_empty() && cfg.chat_id != 0 {
        telegram_send_message(
            &state.http_client,
            &cfg.api_base,
            &cfg.token,
            cfg.chat_id,
            text,
        )
        .await;
    }
}

pub async fn handle_telegram_send_file(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    let raw_path = body
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let caption = body
        .get("caption")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if raw_path.is_empty() {
        return Ok(Json(
            serde_json::json!({"ok": false, "error": "Missing file path"}),
        ));
    }

    let cfg = lock_or_err!(state.telegram_config).clone();
    if !cfg.enabled || cfg.token.is_empty() || cfg.chat_id == 0 {
        return Ok(Json(
            serde_json::json!({"ok": false, "error": "Telegram is not configured"}),
        ));
    }

    // Prevent path traversal: open file first, then canonicalize to avoid TOCTOU
    let data_dir = std::path::Path::new(&state.data_dir)
        .canonicalize()
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": "Cannot resolve data directory"})),
            )
        })?;

    // Open the file first to get a stable handle (prevents symlink swap race)
    let file = tokio::fs::File::open(&raw_path).await.map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "File not found"})),
        )
    })?;

    let requested = std::path::Path::new(raw_path);
    let canonical = requested.canonicalize().map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "File not found"})),
        )
    })?;
    if !canonical.starts_with(&data_dir) {
        return Ok(Json(
            serde_json::json!({"ok": false, "error": "Access denied: file is outside the data directory"}),
        ));
    }

    let metadata = file.metadata().await.map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "File not found"})),
        )
    })?;
    if !metadata.is_file() {
        return Ok(Json(
            serde_json::json!({"ok": false, "error": "Path is not a file"}),
        ));
    }

    let max_upload_bytes = cfg.file_upload_limit_mb.clamp(1, 2000) * 1024 * 1024;
    if metadata.len() > max_upload_bytes {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "error": format!("File exceeds Telegram upload limit ({} MB)", cfg.file_upload_limit_mb.clamp(1, 2000))
        })));
    }

    let file_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document")
        .to_string();
    let stream = FramedRead::new(file, BytesCodec::new());
    let part =
        Part::stream_with_length(Body::wrap_stream(stream), metadata.len()).file_name(file_name);
    let mut form = Form::new()
        .text("chat_id", cfg.chat_id.to_string())
        .part("document", part);
    if !caption.is_empty() {
        form = form.text("caption", caption.to_string());
    }

    let url = telegram_api_url(&cfg.api_base, &cfg.token, "sendDocument");
    let response = state
        .http_client
        .post(url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"ok": false, "error": e.to_string()})),
            )
        })?;

    if response.status().is_success() {
        return Ok(Json(serde_json::json!({"ok": true})));
    }

    let status = response.status();
    let body_text = response
        .text()
        .await
        .unwrap_or_else(|_| "Telegram rejected the file".to_string());
    Ok(Json(serde_json::json!({
        "ok": false,
        "error": format!("Telegram API returned {}: {}", status, body_text)
    })))
}
