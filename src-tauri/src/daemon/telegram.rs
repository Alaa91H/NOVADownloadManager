use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Json;
use reqwest::multipart::{Form, Part};
use reqwest::Body;
use serde_json;
use std::sync::OnceLock;
use std::time::Duration;
use tokio_util::codec::{BytesCodec, FramedRead};

/// Escape HTML special characters to prevent injection in Telegram HTML messages.
fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

use crate::daemon::state::SharedState;
use crate::lock_or_err;

pub async fn handle_telegram_config(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let cfg = lock_or_err!(state.telegram_config).clone();
    let masked = if cfg.token.is_empty() {
        String::new()
    } else if cfg.token.len() <= 8 {
        "****".to_owned()
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
        if let Some(v) = body.get("enabled").and_then(serde_json::Value::as_bool) {
            cfg.enabled = v;
        }
        if let Some(v) = body.get("token").and_then(|v| v.as_str()) {
            cfg.token = v.to_owned();
        }
        if let Some(v) = body.get("chatId").and_then(serde_json::Value::as_i64) {
            cfg.chat_id = v;
        }
        if let Some(v) = body.get("apiBase").and_then(|v| v.as_str()) {
            cfg.api_base = normalize_api_base(v).unwrap_or_else(|| {
                log::warn!(
                    "Rejected Telegram apiBase '{v}': not a trusted HTTPS telegram.org host"
                );
                "https://api.telegram.org".to_owned()
            });
        }
        if let Some(v) = body
            .get("fileUploadLimitMb")
            .and_then(serde_json::Value::as_u64)
        {
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

fn normalize_api_base(api_base: &str) -> Option<String> {
    let trimmed = api_base.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Some("https://api.telegram.org".to_owned());
    }
    // The Telegram bot token is embedded in the API URL, so a malicious
    // apiBase would leak it to an attacker-controlled host. Restrict to the
    // official Telegram host (or a trusted HTTPS mirror of it).
    let parsed = reqwest::Url::parse(trimmed).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    if host == "api.telegram.org" || host.ends_with(".telegram.org") {
        Some(format!("https://{host}"))
    } else {
        None
    }
}

fn telegram_api_url(api_base: &str, token: &str, method: &str) -> String {
    let base =
        normalize_api_base(api_base).unwrap_or_else(|| "https://api.telegram.org".to_owned());
    format!("{base}/bot{token}/{method}")
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
        .is_ok_and(|r| r.status().is_success())
}

fn blocking_client() -> Option<&'static reqwest::blocking::Client> {
    static CLIENT: OnceLock<Option<reqwest::blocking::Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::blocking::Client::builder()
                .build()
                .inspect_err(|e| {
                    log::error!("Failed to create blocking HTTP client for Telegram: {e}");
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
    let client = if let Some(c) = blocking_client() {
        c
    } else {
        log::error!("Cannot send Telegram message: HTTP client not available");
        return false;
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
        .is_ok_and(|r| r.status().is_success())
}

/// Run the Telegram polling loop on a std thread, reusing the daemon's
/// Tokio runtime via its `Handle` (M3) instead of creating a second runtime.
pub fn start_telegram_bot(state: SharedState, runtime_handle: tokio::runtime::Handle) {
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::new();
        while !state
            .shutdown_requested
            .load(std::sync::atomic::Ordering::Acquire)
        {
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
                                if let Some(uid) =
                                    update.get("update_id").and_then(serde_json::Value::as_i64)
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
                                            .and_then(serde_json::Value::as_i64)
                                            .unwrap_or(0);
                                        if from_chat != chat_id {
                                            continue;
                                        }
                                        handle_telegram_command(
                                            &state,
                                            &api_base,
                                            &token,
                                            from_chat,
                                            text,
                                            &runtime_handle,
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

fn run_control_command(
    state: &SharedState,
    rt: &tokio::runtime::Handle,
    command: nova_core_model::ControlCommand,
) -> Result<serde_json::Value, String> {
    let result = rt
        .block_on(crate::daemon::routes::commands::execute_legacy(
            state, command, None,
        ))
        .map_err(|error| error.message)?;
    if result.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        return Err(result
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("The runtime rejected the command.")
            .to_owned());
    }
    Ok(result)
}

fn run_control_query(
    state: &SharedState,
    rt: &tokio::runtime::Handle,
    query: nova_core_model::ControlQuery,
) -> Result<serde_json::Value, String> {
    rt.block_on(crate::daemon::routes::commands::query_legacy(state, query))
        .map_err(|error| error.message)
}

fn parse_json_argument(arg: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(arg.trim()).map_err(|error| format!("Invalid JSON: {error}"))
}

fn required_argument<'a>(arg: &'a str, usage: &str) -> Result<&'a str, String> {
    let value = arg.trim();
    if value.is_empty() {
        Err(format!("Usage: {usage}"))
    } else {
        Ok(value)
    }
}

fn item_summary(item: &serde_json::Value) -> String {
    let id = item
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let name = item
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(id);
    let enabled = item
        .get("enabled")
        .or_else(|| item.get("active"))
        .and_then(serde_json::Value::as_bool)
        .map(|value| if value { "enabled" } else { "disabled" })
        .unwrap_or("");
    format!(
        "• <code>{}</code> — {} {}",
        escape_html(id),
        escape_html(name),
        enabled
    )
}

fn list_reply(value: &serde_json::Value, key: &str, title: &str) -> String {
    let Some(items) = value.get(key).and_then(serde_json::Value::as_array) else {
        return format!("{title}: no data returned.");
    };
    if items.is_empty() {
        return format!("{title}: none.");
    }
    let mut reply = format!("{title} ({})\n", items.len());
    for item in items.iter().take(40) {
        reply.push_str(&item_summary(item));
        reply.push('\n');
    }
    if items.len() > 40 {
        reply.push_str(&format!("… and {} more", items.len() - 40));
    }
    reply
}

fn handle_extended_control_command(
    state: &SharedState,
    rt: &tokio::runtime::Handle,
    cmd: &str,
    arg: &str,
) -> Option<String> {
    use nova_core_model::{ControlCommand as Command, ControlQuery as Query};

    let response: Option<Result<String, String>> = match cmd {
        "/queues" | "/queue-list" => Some(
            run_control_query(state, rt, Query::ListQueues)
                .map(|value| list_reply(&value, "queues", "Queues")),
        ),
        "/queue-create" => Some(
            required_argument(arg, "/queue-create <name>").and_then(|name| {
                run_control_command(
                    state,
                    rt,
                    Command::CreateQueue {
                        name: name.to_owned(),
                        task_id: None,
                    },
                )
                .map(|value| {
                    let id = value
                        .pointer("/queue/id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("created");
                    format!("Queue created: <code>{}</code>", escape_html(id))
                })
            }),
        ),
        "/queue-update" => Some((|| {
            let mut parts = arg.trim().splitn(2, char::is_whitespace);
            let queue_id = parts.next().unwrap_or("");
            let request = parts.next().unwrap_or("").trim();
            if queue_id.is_empty() || request.is_empty() {
                return Err("Usage: /queue-update <queue> <queue JSON>".to_owned());
            }
            let queue = parse_json_argument(request)?;
            run_control_command(
                state,
                rt,
                Command::UpdateQueue {
                    queue_id: queue_id.to_owned(),
                    queue,
                },
            )?;
            Ok(format!(
                "Queue updated: <code>{}</code>",
                escape_html(queue_id)
            ))
        })()),
        "/queue-delete" => Some(
            required_argument(arg, "/queue-delete <queue>").and_then(|id| {
                run_control_command(
                    state,
                    rt,
                    Command::DeleteQueue {
                        queue_id: id.to_owned(),
                    },
                )
                .map(|_| format!("Queue deleted: <code>{}</code>", escape_html(id)))
            }),
        ),
        "/queue-order" => Some(required_argument(arg, "/queue-order <id,id,...>").and_then(
            |ids| {
                run_control_command(
                    state,
                    rt,
                    Command::ReorderQueues {
                        queue_ids: ids.split(',').map(str::trim).map(str::to_owned).collect(),
                    },
                )
                .map(|_| "Queue order updated.".to_owned())
            },
        )),
        "/queue-task-order" => Some((|| {
            let mut parts = arg.trim().splitn(2, char::is_whitespace);
            let queue_id = parts.next().unwrap_or("");
            let ids = parts.next().unwrap_or("").trim();
            if queue_id.is_empty() || ids.is_empty() {
                return Err("Usage: /queue-task-order <queue> <task-id,task-id,...>".to_owned());
            }
            run_control_command(
                state,
                rt,
                Command::ReorderQueueTasks {
                    queue_id: queue_id.to_owned(),
                    task_ids: ids.split(',').map(str::trim).map(str::to_owned).collect(),
                },
            )?;
            Ok(format!(
                "Task order updated for <code>{}</code>.",
                escape_html(queue_id)
            ))
        })()),
        "/profiles" | "/profile" => Some(run_control_query(state, rt, Query::ListProfiles).map(
            |value| {
                let active = value
                    .get("active_profile")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown");
                format!(
                    "Active profile: <code>{}</code>\n{}",
                    escape_html(active),
                    list_reply(&value, "profiles", "Profiles")
                )
            },
        )),
        "/profile-set" => Some(
            required_argument(arg, "/profile-set <profile-id>").and_then(|id| {
                run_control_command(
                    state,
                    rt,
                    Command::SetActiveProfile {
                        profile_id: id.to_owned(),
                    },
                )
                .map(|_| format!("Active profile set to <code>{}</code>.", escape_html(id)))
            }),
        ),
        "/profile-upsert" => Some(parse_json_argument(arg).and_then(|request| {
            run_control_command(state, rt, Command::UpsertProfile { request }).map(|value| {
                format!(
                    "Profile saved: <code>{}</code>",
                    escape_html(
                        value
                            .get("profile_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                    )
                )
            })
        })),
        "/profile-delete" => Some(
            required_argument(arg, "/profile-delete <profile-id>").and_then(|id| {
                run_control_command(
                    state,
                    rt,
                    Command::DeleteProfile {
                        profile_id: id.to_owned(),
                    },
                )
                .map(|_| format!("Profile deleted: <code>{}</code>.", escape_html(id)))
            }),
        ),
        "/rules" => Some(
            run_control_query(state, rt, Query::ListRules)
                .map(|value| list_reply(&value, "rules", "Download rules")),
        ),
        "/rule-add" => Some(parse_json_argument(arg).and_then(|request| {
            run_control_command(state, rt, Command::AddRule { request }).map(|value| {
                format!(
                    "Rule added: <code>{}</code>",
                    escape_html(
                        value
                            .get("rule_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("unknown")
                    )
                )
            })
        })),
        "/rule-delete" => Some(
            required_argument(arg, "/rule-delete <rule-id>").and_then(|id| {
                run_control_command(
                    state,
                    rt,
                    Command::DeleteRule {
                        rule_id: id.to_owned(),
                    },
                )
                .map(|_| format!("Rule deleted: <code>{}</code>.", escape_html(id)))
            }),
        ),
        "/schedules" => Some(
            run_control_query(state, rt, Query::ListSchedules)
                .map(|value| list_reply(&value, "rules", "Schedules")),
        ),
        "/schedule-add" | "/schedule-update" => {
            Some(parse_json_argument(arg).and_then(|request| {
                let command = if cmd == "/schedule-add" {
                    Command::AddSchedule { request }
                } else {
                    Command::UpdateSchedule { request }
                };
                run_control_command(state, rt, command).map(|value| {
                    let id = value
                        .get("rule_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown");
                    format!("Schedule saved: <code>{}</code>", escape_html(id))
                })
            }))
        }
        "/schedule-delete" => Some(
            required_argument(arg, "/schedule-delete <schedule-id>").and_then(|id| {
                run_control_command(
                    state,
                    rt,
                    Command::DeleteSchedule {
                        schedule_id: id.to_owned(),
                    },
                )
                .map(|_| format!("Schedule deleted: <code>{}</code>.", escape_html(id)))
            }),
        ),
        "/scheduler-power" => Some(match arg.trim().to_ascii_lowercase().as_str() {
            "on" | "true" => run_control_command(
                state,
                rt,
                Command::SetSchedulerPowerCommands { enabled: true },
            )
            .map(|_| "Scheduler power actions enabled.".to_owned()),
            "off" | "false" => run_control_command(
                state,
                rt,
                Command::SetSchedulerPowerCommands { enabled: false },
            )
            .map(|_| "Scheduler power actions disabled.".to_owned()),
            _ => Err("Usage: /scheduler-power on|off".to_owned()),
        }),
        "/media-playlist" => Some(parse_json_argument(arg).and_then(|request| {
            run_control_command(state, rt, Command::AddMediaPlaylist { request }).map(|value| {
                format!(
                    "Playlist queued ({} items).",
                    value
                        .get("count")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                )
            })
        })),
        "/torrent-add" => Some(parse_json_argument(arg).and_then(|request| {
            run_control_command(state, rt, Command::AddTorrent { request }).map(|value| {
                format!(
                    "Torrent task added: {}",
                    escape_html(
                        value
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("task")
                    )
                )
            })
        })),
        "/batch" => Some(parse_json_argument(arg).and_then(|value| {
            let commands: Vec<Command> = serde_json::from_value(value)
                .map_err(|error| format!("Batch must be a JSON array of commands: {error}"))?;
            run_control_command(
                state,
                rt,
                Command::Batch {
                    mode: nova_core_model::BatchMode::BestEffort,
                    commands,
                },
            )
            .map(|value| {
                format!(
                    "Batch finished: {} succeeded, {} failed.",
                    value
                        .get("succeeded")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0),
                    value
                        .get("failed")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or(0)
                )
            })
        })),
        "/capabilities" => Some(
            run_control_query(state, rt, Query::Capabilities).map(|value| {
                let capabilities = value
                    .pointer("/controlPlane/commandCapabilities")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                format!(
                    "Runtime capabilities:\n{}",
                    escape_html(&capabilities.to_string())
                )
            }),
        ),
        _ => None,
    };

    response.map(|result| result.unwrap_or_else(|error| format!("Failed: {}", escape_html(&error))))
}

fn handle_telegram_command(
    state: &SharedState,
    api_base: &str,
    token: &str,
    chat_id: i64,
    text: &str,
    rt: &tokio::runtime::Handle,
) {
    let text = text.trim();
    if text.starts_with('/') {
        let mut parts = text.splitn(2, char::is_whitespace);
        let cmd = parts.next().unwrap_or("").split('@').next().unwrap_or("");
        let arg = parts.next().unwrap_or("").trim_start();

        if let Some(reply) = handle_extended_control_command(state, rt, cmd, arg) {
            send_telegram_msg_blocking_with_api(api_base, token, chat_id, &reply);
            return;
        }

        match cmd {
            "/start" | "/help" => {
                let help = "NOVA Bot Commands:\n".to_owned()
                    + "/list - List all downloads\n"
                    + "/add <url> - Add download\n"
                    + "/media <url> - Add a native media download\n"
                    + "/pause <id> - Pause download\n"
                    + "/resume <id> - Resume download\n"
                    + "/retry <id> - Retry a failed download\n"
                    + "/delete <id> - Delete download\n"
                    + "/move <id> <queue> - Move a download to a queue\n"
                    + "/priority <id> <0-4> - Set download priority\n"
                    + "/queue-start <queue> - Start a queue\n"
                    + "/queue-stop <queue> - Stop a queue\n"
                    + "/queues, /profiles, /rules, /schedules - List policy state\n"
                    + "/queue-create|queue-delete|queue-update <...> - Manage queues\n"
                    + "/profile-set|profile-upsert|profile-delete <...> - Manage profiles\n"
                    + "/rule-add|rule-delete <...> - Manage rules\n"
                    + "/schedule-add|schedule-update|schedule-delete <...> - Manage schedules\n"
                    + "/scheduler-power on|off - Allow scheduler power actions\n"
                    + "/media-playlist <JSON> - Add a native media playlist\n"
                    + "/torrent-add <JSON> - Create an analyzed torrent task\n"
                    + "/batch <JSON> - Run a best-effort command batch\n"
                    + "/help - Show this help";
                send_telegram_msg_blocking_with_api(api_base, token, chat_id, &help);
            }
            "/list" => {
                let page = rt.block_on(crate::daemon::routes::commands::query_legacy(
                    state,
                    nova_core_model::ControlQuery::ListTasks {
                        filter: nova_core_model::TaskQueryFilter {
                            limit: Some(100),
                            ..Default::default()
                        },
                    },
                ));
                let page = match page {
                    Ok(page) => page,
                    Err(error) => {
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Could not list downloads: {}", escape_html(&error.message)),
                        );
                        return;
                    }
                };
                let items = page
                    .get("items")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([]));
                let tasks: Vec<nova_core_model::Task> = match serde_json::from_value(items) {
                    Ok(tasks) => tasks,
                    Err(error) => {
                        log::error!("Control Plane task query returned invalid data: {error}");
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            "Could not read the downloads list.",
                        );
                        return;
                    }
                };
                let total = page
                    .get("total")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(tasks.len() as u64) as usize;
                if total == 0 {
                    send_telegram_msg_blocking_with_api(api_base, token, chat_id, "No downloads.");
                } else {
                    let mut msg = format!("Downloads ({total})\n\n");
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
                            escape_html(&t.name),
                            pct
                        ));
                    }
                    if total > 20 {
                        msg.push_str(&format!("\n... and {} more", total - 20));
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
                        &format!("Blocked: {e}"),
                    );
                    return;
                }
                let command = nova_core_model::ControlCommand::AddDownload {
                    request: serde_json::json!({
                        "url": arg,
                        "startImmediately": true,
                    }),
                };
                match rt.block_on(crate::daemon::routes::commands::execute_legacy(
                    state, command, None,
                )) {
                    Ok(result) => {
                        let name = result
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(arg);
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Added: {}", escape_html(name)),
                        );
                    }
                    Err(e) => {
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Failed: {}", escape_html(&e.message)),
                        );
                    }
                }
            }
            "/media" => {
                if arg.trim().is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        "Usage: /media <url>",
                    );
                    return;
                }
                if let Err(error) = crate::daemon::utils::is_safe_target_url(arg.trim()) {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Blocked: {}", escape_html(&error)),
                    );
                    return;
                }
                let command = nova_core_model::ControlCommand::AddMediaDownload {
                    request: serde_json::json!({
                        "url": arg.trim(),
                        "startImmediately": true,
                        "mediaOptions": {},
                    }),
                };
                match rt.block_on(crate::daemon::routes::commands::execute_legacy(
                    state, command, None,
                )) {
                    Ok(result) => {
                        let name = result
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(arg.trim());
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            &format!("Media added: {}", escape_html(name)),
                        );
                    }
                    Err(error) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Failed: {}", escape_html(&error.message)),
                    ),
                }
            }
            "/pause" | "/resume" | "/delete" => {
                if arg.is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Usage: {cmd} <id>"),
                    );
                    return;
                }
                match cmd {
                    "/pause" | "/resume" | "/delete" => {
                        let command = match cmd {
                            "/pause" => nova_core_model::ControlCommand::PauseTask {
                                task_id: arg.trim().to_owned(),
                            },
                            "/resume" => nova_core_model::ControlCommand::ResumeTask {
                                task_id: arg.trim().to_owned(),
                            },
                            _ => nova_core_model::ControlCommand::DeleteTask {
                                task_id: arg.trim().to_owned(),
                                delete_files: false,
                            },
                        };
                        match run_control_command(state, rt, command) {
                            Ok(_) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                &format!("{}: {}", cmd.trim_start_matches('/'), arg.trim()),
                            ),
                            Err(error) => send_telegram_msg_blocking_with_api(
                                api_base,
                                token,
                                chat_id,
                                &format!("Failed: {}", escape_html(&error)),
                            ),
                        }
                    }
                    _ => {}
                }
            }
            "/retry" => {
                if arg.trim().is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        "Usage: /retry <id>",
                    );
                    return;
                }
                match rt.block_on(crate::daemon::routes::commands::execute_legacy(
                    state,
                    nova_core_model::ControlCommand::RetryTask {
                        task_id: arg.trim().to_owned(),
                    },
                    None,
                )) {
                    Ok(_) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Retry requested: {}", arg.trim()),
                    ),
                    Err(error) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Failed: {}", escape_html(&error.message)),
                    ),
                }
            }
            "/queue-start" | "/queue-stop" => {
                let queue_id = arg.trim();
                if queue_id.is_empty() {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Usage: {cmd} <queue>"),
                    );
                    return;
                }
                let command = if cmd == "/queue-start" {
                    nova_core_model::ControlCommand::StartQueue {
                        queue_id: queue_id.to_owned(),
                    }
                } else {
                    nova_core_model::ControlCommand::StopQueue {
                        queue_id: queue_id.to_owned(),
                    }
                };
                match rt.block_on(crate::daemon::routes::commands::execute_legacy(
                    state, command, None,
                )) {
                    Ok(_) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!(
                            "Queue {}: {queue_id}",
                            if cmd == "/queue-start" {
                                "started"
                            } else {
                                "stopped"
                            }
                        ),
                    ),
                    Err(error) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Failed: {}", escape_html(&error.message)),
                    ),
                }
            }
            "/move" | "/priority" => {
                let mut args = arg.split_whitespace();
                let Some(task_id) = args.next() else {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!(
                            "Usage: {cmd} <id> {}",
                            if cmd == "/move" { "<queue>" } else { "<0-4>" }
                        ),
                    );
                    return;
                };
                let Some(value) = args.next() else {
                    send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!(
                            "Usage: {cmd} <id> {}",
                            if cmd == "/move" { "<queue>" } else { "<0-4>" }
                        ),
                    );
                    return;
                };
                let command = if cmd == "/move" {
                    nova_core_model::ControlCommand::MoveTask {
                        task_id: task_id.to_owned(),
                        queue_id: value.to_owned(),
                    }
                } else {
                    let Ok(priority) = value.parse::<u32>() else {
                        send_telegram_msg_blocking_with_api(
                            api_base,
                            token,
                            chat_id,
                            "Priority must be a number from 0 to 4.",
                        );
                        return;
                    };
                    nova_core_model::ControlCommand::SetTaskPriority {
                        task_id: task_id.to_owned(),
                        priority,
                    }
                };
                match rt.block_on(crate::daemon::routes::commands::execute_legacy(
                    state, command, None,
                )) {
                    Ok(_) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Updated {task_id}."),
                    ),
                    Err(error) => send_telegram_msg_blocking_with_api(
                        api_base,
                        token,
                        chat_id,
                        &format!("Failed: {}", escape_html(&error.message)),
                    ),
                }
            }
            _ => {
                send_telegram_msg_blocking_with_api(
                    api_base,
                    token,
                    chat_id,
                    &format!("Unknown command: {cmd}\nUse /help for available commands."),
                );
            }
        }
    }
}

pub async fn telegram_notify(state: &SharedState, text: &str) {
    let cfg = match state.telegram_config.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => {
            log::error!("Mutex poisoned in telegram_notify: {poisoned}");
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

/// Telegram is a notification adapter over Runtime events; it does not invoke
/// download services or interpret user commands here.
pub(crate) fn format_event_notification(
    event: &crate::daemon::engine::event_bus::EngineEvent,
) -> Option<String> {
    use crate::daemon::engine::event_bus::EngineEvent;
    match event {
        EngineEvent::DownloadComplete {
            task_id,
            total_bytes,
            ..
        } => Some(format!(
            "NOVA download completed: {task_id} ({total_bytes} bytes)."
        )),
        EngineEvent::DownloadFailed {
            task_id,
            will_retry,
            retry_in_secs,
            ..
        } => Some(if *will_retry {
            format!(
                "NOVA download failed and will retry: {task_id} (in {} seconds).",
                retry_in_secs.unwrap_or_default()
            )
        } else {
            format!("NOVA download failed: {task_id}.")
        }),
        _ => None,
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

    // Canonicalize data directory first
    let data_dir = std::path::Path::new(&state.data_dir)
        .canonicalize()
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"ok": false, "error": "Cannot resolve data directory"})),
            )
        })?;

    // Open file FIRST, then canonicalize the opened file to avoid TOCTOU symlink swap
    let file = tokio::fs::File::open(raw_path).await.map_err(|_| {
        (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"ok": false, "error": "File not found"})),
        )
    })?;

    // Get canonical path from the opened file descriptor
    let canonical = std::path::PathBuf::from(raw_path)
        .canonicalize()
        .map_err(|_| {
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
        .to_owned();
    let stream = FramedRead::new(file, BytesCodec::new());
    let part =
        Part::stream_with_length(Body::wrap_stream(stream), metadata.len()).file_name(file_name);
    let mut form = Form::new()
        .text("chat_id", cfg.chat_id.to_string())
        .part("document", part);
    if !caption.is_empty() {
        form = form.text("caption", caption.to_owned());
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
        .unwrap_or_else(|_| "Telegram rejected the file".to_owned());
    Ok(Json(serde_json::json!({
        "ok": false,
        "error": format!("Telegram API returned {}: {}", status, body_text)
    })))
}
