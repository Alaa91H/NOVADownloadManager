use std::sync::OnceLock;
use std::time::Duration;
use axum::extract::{Path as AxumPath, State};
use axum::response::Json;
use serde_json;

use crate::daemon::aria2::list_all_tasks;
use crate::daemon::routes::{handle_delete_task, handle_pause_task, handle_resume_task};
use crate::daemon::state::SharedState;
use crate::daemon::types::CreateDownloadBody;
use crate::lock_or_err;

pub async fn handle_telegram_config(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let cfg = lock_or_err!(state.telegram_config).clone();
    Json(serde_json::json!({
        "enabled": cfg.enabled,
        "token": cfg.token,
        "chatId": cfg.chat_id,
    }))
}

pub async fn handle_telegram_update_config(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    if let Ok(mut cfg) = state.telegram_config.lock() {
        if let Some(v) = body.get("enabled").and_then(|v| v.as_bool()) { cfg.enabled = v; }
        if let Some(v) = body.get("token").and_then(|v| v.as_str()) { cfg.token = v.to_string(); }
        if let Some(v) = body.get("chatId").and_then(|v| v.as_i64()) { cfg.chat_id = v; }
    }
    Json(serde_json::json!({"ok": true}))
}

pub async fn handle_telegram_test(
    State(state): State<SharedState>,
) -> Json<serde_json::Value> {
    let cfg = lock_or_err!(state.telegram_config).clone();
    if cfg.token.is_empty() {
        return Json(serde_json::json!({"ok": false, "error": "Token not set"}));
    }
    let msg = format!("NOVA Telegram Bot is working!\nChat ID: {}", cfg.chat_id);
    let ok = telegram_send_message(&state.http_client, &cfg.token, cfg.chat_id, &msg).await;
    Json(serde_json::json!({"ok": ok}))
}

async fn telegram_send_message(client: &reqwest::Client, token: &str, chat_id: i64, text: &str) -> bool {
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    client.post(&url)
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

fn blocking_client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .build()
            .expect("Failed to create blocking HTTP client")
    })
}

pub fn send_telegram_msg_blocking(token: &str, chat_id: i64, text: &str) -> bool {
    let url = format!("https://api.telegram.org/bot{}/sendMessage", token);
    blocking_client().post(&url)
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
            let (token, enabled, chat_id) = {
                let cfg = lock_or_err!(state.telegram_config);
                (cfg.token.clone(), cfg.enabled, cfg.chat_id)
            };
            let last_update_id = *lock_or_err!(state.telegram_last_update_id);
            if enabled && !token.is_empty() {
                let url = format!("https://api.telegram.org/bot{}/getUpdates", token);
                if let Ok(resp) = client.post(&url)
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
                                if let Some(uid) = update.get("update_id").and_then(|u| u.as_i64()) {
                                    if let Ok(mut lid) = state.telegram_last_update_id.lock() {
                                        *lid = uid;
                                        state.mark_dirty();
                                    }
                                }
                                if let Some(msg) = update.get("message") {
                                    if let Some(text) = msg.get("text").and_then(|t| t.as_str()) {
                                        let from_chat = msg.get("chat").and_then(|c| c.get("id")).and_then(|i| i.as_i64()).unwrap_or(0);
                                        if from_chat != chat_id {
                                            continue;
                                        }
                                        handle_telegram_command(&state, &token, from_chat, text, &rt);
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

fn handle_telegram_command(state: &SharedState, token: &str, chat_id: i64, text: &str, rt: &tokio::runtime::Runtime) {
    let text = text.trim();
    if text.starts_with('/') {
        let parts: Vec<&str> = text.splitn(2, ' ').collect();
        let cmd = parts[0];
        let arg = parts.get(1).copied().unwrap_or("");

        match cmd {
            "/start" | "/help" => {
                let help = "NOVA Bot Commands:\n"
                    .to_string()
                    + "/list - List all downloads\n"
                    + "/add <url> - Add download\n"
                    + "/pause <id> - Pause download\n"
                    + "/resume <id> - Resume download\n"
                    + "/delete <id> - Delete download\n"
                    + "/help - Show this help";
                send_telegram_msg_blocking(token, chat_id, &help);
            }
            "/list" => {
                let tasks = rt.block_on(list_all_tasks(state));
                if tasks.is_empty() {
                    send_telegram_msg_blocking(token, chat_id, "No downloads.");
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
                        let pct = if t.size_bytes > 0 { (t.downloaded_bytes as f64 / t.size_bytes as f64 * 100.0) as u64 } else { 0 };
                        msg.push_str(&format!("{} <code>{}</code> - {} ({}%)\n", icon, &t.id[..t.id.len().min(8)], t.name, pct));
                    }
                    if tasks.len() > 20 {
                        msg.push_str(&format!("\n... and {} more", tasks.len() - 20));
                    }
                    send_telegram_msg_blocking(token, chat_id, &msg);
                }
            }
            "/add" => {
                if arg.is_empty() {
                    send_telegram_msg_blocking(token, chat_id, "Usage: /add <url>");
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
                match rt.block_on(crate::daemon::aria2::create_aria2_task(state, &body)) {
                    Ok(task) => {
                        send_telegram_msg_blocking(token, chat_id, &format!("Added: {}", task.name));
                    }
                    Err(e) => {
                        send_telegram_msg_blocking(token, chat_id, &format!("Failed: {}", e));
                    }
                }
            }
            "/pause" | "/resume" | "/delete" => {
                if arg.is_empty() {
                    send_telegram_msg_blocking(token, chat_id, &format!("Usage: {} <id>", cmd));
                    return;
                }
                match cmd {
                    "/pause" => {
                        let result = rt.block_on(async {
                            handle_pause_task(State(state.clone()), AxumPath(arg.to_string())).await
                        });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking(token, chat_id, &format!("Paused: {}", arg)),
                            Err(e) => send_telegram_msg_blocking(token, chat_id, e.1 .0.get("error").and_then(|v| v.as_str()).unwrap_or("unknown")),
                        };
                    }
                    "/resume" => {
                        let result = rt.block_on(async {
                            handle_resume_task(State(state.clone()), AxumPath(arg.to_string())).await
                        });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking(token, chat_id, &format!("Resumed: {}", arg)),
                            Err(e) => send_telegram_msg_blocking(token, chat_id, e.1 .0.get("error").and_then(|v| v.as_str()).unwrap_or("unknown")),
                        };
                    }
                    "/delete" => {
                        let result = rt.block_on(async {
                            handle_delete_task(State(state.clone()), AxumPath(arg.to_string())).await
                        });
                        let _ = match result {
                            Ok(_) => send_telegram_msg_blocking(token, chat_id, &format!("Deleted: {}", arg)),
                            Err(e) => send_telegram_msg_blocking(token, chat_id, e.1 .0.get("error").and_then(|v| v.as_str()).unwrap_or("unknown")),
                        };
                    }
                    _ => {}
                }
            }
            _ => {
                send_telegram_msg_blocking(token, chat_id, &format!("Unknown command: {}\nUse /help for available commands.", cmd));
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
        telegram_send_message(&state.http_client, &cfg.token, cfg.chat_id, text).await;
    }
}
