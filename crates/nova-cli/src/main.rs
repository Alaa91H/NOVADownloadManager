use nova_core_model::{
    BatchMode, CommandEnvelope, ControlCommand, ControlQuery, QueryEnvelope, TaskQueryFilter,
    CONTROL_PLANE_CONTRACT_VERSION,
};
use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

enum Request {
    Command(ControlCommand),
    Query(ControlQuery),
    Capabilities,
    Unsupported(String),
}

fn main() {
    if let Err(error) = run() {
        eprintln!("nova: {error}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
        print_help();
        return Ok(());
    }

    let idempotency_key = extract_idempotency_key(&mut args)?;
    let request = build_request(&args)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("cannot initialize HTTP client: {error}"))?;
    let token = env::var("NOVA_API_TOKEN")
        .map_err(|_| "set NOVA_API_TOKEN to the daemon's local bearer token".to_owned())?;
    if token.trim().is_empty() {
        return Err("NOVA_API_TOKEN cannot be empty".to_owned());
    }
    let base_url = env::var("NOVA_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3199".to_owned());
    validate_local_url(&base_url)?;

    let capabilities = get_capabilities(&client, &base_url, &token)?;
    let output = match request {
        Request::Capabilities => capabilities,
        Request::Unsupported(reason) => return Err(reason),
        Request::Command(command) => {
            ensure_command_available(&capabilities, &command)?;
            let now = timestamp_nanos();
            let generated_key = format!("nova-cli-{}-{now}", std::process::id());
            let envelope = CommandEnvelope {
                contract_version: CONTROL_PLANE_CONTRACT_VERSION,
                request_id: format!("nova-cli-{}-{now}", std::process::id()),
                idempotency_key: idempotency_key.unwrap_or(generated_key),
                command,
            };
            post_json(
                &client,
                &base_url,
                &token,
                "/api/v1/commands",
                &envelope,
            )?
        }
        Request::Query(query) => {
            ensure_query_available(&capabilities, &query)?;
            let envelope = QueryEnvelope {
                contract_version: CONTROL_PLANE_CONTRACT_VERSION,
                request_id: format!("nova-cli-{}-{}", std::process::id(), timestamp_nanos()),
                query,
            };
            post_json(
                &client,
                &base_url,
                &token,
                "/api/v1/queries",
                &envelope,
            )?
        }
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&output)
            .map_err(|error| format!("cannot render response: {error}"))?
    );
    Ok(())
}

fn build_request(args: &[String]) -> Result<Request, String> {
    let usage = || "run `nova help` to see supported command forms".to_owned();
    let command = args[0].as_str();
    let rest = &args[1..];
    let request = match command {
        "capabilities" => Request::Capabilities,
        "list" => Request::Query(ControlQuery::ListTasks {
            filter: TaskQueryFilter {
                limit: Some(100),
                ..Default::default()
            },
        }),
        "inspect" => Request::Query(ControlQuery::GetTask {
            task_id: required(rest.first(), "inspect <task-id>")?,
        }),
        "events" => Request::Query(ControlQuery::Events {
            cursor: rest.first().cloned(),
            limit: Some(100),
        }),
        "diagnostics" => Request::Query(ControlQuery::Diagnostics),
        "logs" => {
            let limit = rest
                .first()
                .map(|value| {
                    value
                        .parse::<u32>()
                        .map_err(|error| format!("invalid log limit `{value}`: {error}"))
                })
                .transpose()?;
            Request::Query(ControlQuery::RecentLogs {
                limit,
                level: rest.get(1).cloned(),
            })
        }
        "add" => Request::Command(ControlCommand::AddDownload {
            request: serde_json::json!({
                "url": required(rest.first(), "add <url>")?,
                "startImmediately": true,
            }),
        }),
        "pause" => Request::Command(ControlCommand::PauseTask {
            task_id: required(rest.first(), "pause <task-id>")?,
        }),
        "resume" => Request::Command(ControlCommand::ResumeTask {
            task_id: required(rest.first(), "resume <task-id>")?,
        }),
        "retry" => Request::Command(ControlCommand::RetryTask {
            task_id: required(rest.first(), "retry <task-id>")?,
        }),
        "redownload" => Request::Command(ControlCommand::RedownloadTask {
            task_id: required(rest.first(), "redownload <task-id>")?,
        }),
        "move" => Request::Command(ControlCommand::MoveTask {
            task_id: required(rest.first(), "move <task-id> <queue-id>")?,
            queue_id: required(rest.get(1), "move <task-id> <queue-id>")?,
        }),
        "priority" => {
            let task_id = required(rest.first(), "priority <task-id> <0-4>")?;
            let raw_priority = required(rest.get(1), "priority <task-id> <0-4>")?;
            let priority = raw_priority
                .parse::<u32>()
                .map_err(|error| format!("invalid priority `{raw_priority}`: {error}"))?;
            if priority > 4 {
                return Err("priority must be between 0 and 4".to_owned());
            }
            Request::Command(ControlCommand::SetTaskPriority { task_id, priority })
        }
        "update" => Request::Command(ControlCommand::UpdateTask {
            task_id: required(rest.first(), "update <task-id> <json>")?,
            request: json_argument(rest.get(1), "update <task-id> <json>")?,
        }),
        "delete" => Request::Command(ControlCommand::DeleteTask {
            task_id: required(rest.first(), "delete <task-id> [--files]")?,
            delete_files: rest.iter().any(|arg| arg == "--files"),
        }),
        "batch" => {
            let value = json_argument(rest.first(), "batch <json-command-array>")?;
            let commands = serde_json::from_value::<Vec<ControlCommand>>(value)
                .map_err(|error| format!("batch input must be an array of commands: {error}"))?;
            Request::Command(ControlCommand::Batch {
                mode: BatchMode::BestEffort,
                commands,
            })
        }
        "queue" => queue_request(rest)?,
        "profile" => profile_request(rest)?,
        "rules" => rules_request(rest)?,
        "schedule" => schedule_request(rest)?,
        "media" => media_request(rest)?,
        "torrent" => torrent_request(rest)?,
        "network" => Request::Unsupported(
            "this runtime build does not expose Network Profile commands in the v1 contract".to_owned(),
        ),
        "config" => Request::Unsupported(
            "unified settings queries are not yet exposed by the v1 contract".to_owned(),
        ),
        _ => return Err(format!("unknown command `{command}`; {}", usage())),
    };
    Ok(request)
}

fn queue_request(args: &[String]) -> Result<Request, String> {
    use ControlCommand as C;
    use ControlQuery as Q;
    let action = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1..];
    match action {
        "list" => Ok(Request::Query(Q::ListQueues)),
        "start" => Ok(Request::Command(C::StartQueue {
            queue_id: required(rest.first(), "queue start <queue-id>")?,
        })),
        "stop" => Ok(Request::Command(C::StopQueue {
            queue_id: required(rest.first(), "queue stop <queue-id>")?,
        })),
        "create" => Ok(Request::Command(C::CreateQueue {
            name: rest.join(" "),
            task_id: None,
        })),
        "delete" => Ok(Request::Command(C::DeleteQueue {
            queue_id: required(rest.first(), "queue delete <queue-id>")?,
        })),
        "update" => Ok(Request::Command(C::UpdateQueue {
            queue_id: required(rest.first(), "queue update <queue-id> <json>")?,
            queue: json_argument(rest.get(1), "queue update <queue-id> <json>")?,
        })),
        "order" => Ok(Request::Command(C::ReorderQueues {
            queue_ids: comma_ids(required(rest.first(), "queue order <id,id,...>")?),
        })),
        "task-order" => Ok(Request::Command(C::ReorderQueueTasks {
            queue_id: required(rest.first(), "queue task-order <queue-id> <task-id,task-id,...>")?,
            task_ids: comma_ids(required(rest.get(1), "queue task-order <queue-id> <task-id,task-id,...>")?),
        })),
        _ => Err("queue action must be list|start|stop|create|update|delete|order|task-order".to_owned()),
    }
}

fn profile_request(args: &[String]) -> Result<Request, String> {
    use ControlCommand as C;
    use ControlQuery as Q;
    let action = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1..];
    match action {
        "list" => Ok(Request::Query(Q::ListProfiles)),
        "get" => Ok(Request::Query(Q::GetProfile {
            profile_id: required(rest.first(), "profile get <profile-id>")?,
        })),
        "set" => Ok(Request::Command(C::SetActiveProfile {
            profile_id: required(rest.first(), "profile set <profile-id>")?,
        })),
        "upsert" => Ok(Request::Command(C::UpsertProfile {
            request: json_argument(rest.first(), "profile upsert <json>")?,
        })),
        "delete" => Ok(Request::Command(C::DeleteProfile {
            profile_id: required(rest.first(), "profile delete <profile-id>")?,
        })),
        _ => Err("profile action must be list|get|set|upsert|delete".to_owned()),
    }
}

fn rules_request(args: &[String]) -> Result<Request, String> {
    use ControlCommand as C;
    use ControlQuery as Q;
    let action = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1..];
    match action {
        "list" => Ok(Request::Query(Q::ListRules)),
        "add" => Ok(Request::Command(C::AddRule {
            request: json_argument(rest.first(), "rules add <json>")?,
        })),
        "delete" => Ok(Request::Command(C::DeleteRule {
            rule_id: required(rest.first(), "rules delete <rule-id>")?,
        })),
        _ => Err("rules action must be list|add|delete".to_owned()),
    }
}

fn schedule_request(args: &[String]) -> Result<Request, String> {
    use ControlCommand as C;
    use ControlQuery as Q;
    let action = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1..];
    match action {
        "list" => Ok(Request::Query(Q::ListSchedules)),
        "add" => Ok(Request::Command(C::AddSchedule {
            request: json_argument(rest.first(), "schedule add <json>")?,
        })),
        "update" => Ok(Request::Command(C::UpdateSchedule {
            request: json_argument(rest.first(), "schedule update <json>")?,
        })),
        "delete" => Ok(Request::Command(C::DeleteSchedule {
            schedule_id: required(rest.first(), "schedule delete <schedule-id>")?,
        })),
        "power" => {
            let enabled = match rest.first().map(String::as_str) {
                Some("on") => true,
                Some("off") => false,
                _ => return Err("schedule power must be on|off".to_owned()),
            };
            Ok(Request::Command(C::SetSchedulerPowerCommands { enabled }))
        }
        _ => Err("schedule action must be list|add|update|delete|power".to_owned()),
    }
}

fn media_request(args: &[String]) -> Result<Request, String> {
    use ControlCommand as C;
    let action = args.first().map(String::as_str).unwrap_or("");
    let rest = &args[1..];
    match action {
        "add" => {
            let request = match rest.first().map(String::as_str) {
                Some(raw) if raw.trim_start().starts_with('{') => {
                    json_argument(rest.first(), "media add <url|json>")?
                }
                _ => serde_json::json!({
                    "url": required(rest.first(), "media add <url|json>")?,
                    "startImmediately": true,
                    "mediaOptions": {},
                }),
            };
            Ok(Request::Command(C::AddMediaDownload { request }))
        }
        "playlist" => Ok(Request::Command(C::AddMediaPlaylist {
            request: json_argument(rest.first(), "media playlist <json>")?,
        })),
        _ => Err("media action must be add|playlist".to_owned()),
    }
}

fn torrent_request(args: &[String]) -> Result<Request, String> {
    match args.first().map(String::as_str).unwrap_or("") {
        "add" => Ok(Request::Command(ControlCommand::AddTorrent {
            request: json_argument(args.get(1), "torrent add <json>")?,
        })),
        _ => Err("torrent action must be add".to_owned()),
    }
}

fn required(value: Option<&String>, usage: &str) -> Result<String, String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("missing argument; usage: nova {usage}"))
}

fn extract_idempotency_key(args: &mut Vec<String>) -> Result<Option<String>, String> {
    let mut found = None;
    let mut index = 0;
    while index < args.len() {
        let value = if args[index] == "--idempotency-key" {
            if index + 1 >= args.len() {
                return Err("--idempotency-key requires a value".to_owned());
            }
            let value = args.remove(index + 1);
            args.remove(index);
            Some(value)
        } else if let Some(value) = args[index].strip_prefix("--idempotency-key=") {
            let value = value.to_owned();
            args.remove(index);
            Some(value)
        } else {
            index += 1;
            None
        };
        if let Some(value) = value {
            if found.is_some() {
                return Err("--idempotency-key may be specified only once".to_owned());
            }
            found = Some(value);
        }
    }
    let key = found.or_else(|| env::var("NOVA_IDEMPOTENCY_KEY").ok());
    if key.as_ref().is_some_and(|value| {
        value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control)
    }) {
        return Err("idempotency key must be 1–128 bytes and contain no control characters".to_owned());
    }
    Ok(key.map(|value| value.trim().to_owned()))
}

fn json_argument(value: Option<&String>, usage: &str) -> Result<serde_json::Value, String> {
    let value = required(value, usage)?;
    serde_json::from_str(&value).map_err(|error| format!("invalid JSON for `{usage}`: {error}"))
}

fn comma_ids(value: String) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn ensure_command_available(
    capabilities: &serde_json::Value,
    command: &ControlCommand,
) -> Result<(), String> {
    let (capability_id, runtime_capability_id) = match command {
        ControlCommand::Batch { mode, commands } => {
            let batch_id = match mode {
                BatchMode::BestEffort => "batch.bestEffort",
                BatchMode::Atomic => "batch.atomic",
            };
            ensure_capability_supported(capabilities, batch_id)?;
            for command in commands {
                ensure_command_available(capabilities, command)?;
            }
            return Ok(());
        }
        ControlCommand::AddDownload { request } => (
            "addDownload",
            Some(
                if request
                    .get("url")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|url| {
                        url.trim()
                            .get(..7)
                            .is_some_and(|scheme| scheme.eq_ignore_ascii_case("magnet:"))
                    })
                {
                    "torrent.core"
                } else {
                    "download.direct"
                },
            ),
        ),
        ControlCommand::AddMediaDownload { .. } => ("addMediaDownload", Some("media.extraction")),
        ControlCommand::AddMediaPlaylist { .. } => ("addMediaPlaylist", Some("media.extraction")),
        ControlCommand::AddTorrent { .. } => ("addTorrent", Some("torrent.core")),
        ControlCommand::PauseTask { .. } => ("pauseTask", None),
        ControlCommand::ResumeTask { .. } => ("resumeTask", None),
        ControlCommand::RetryTask { .. } => ("retryTask", None),
        ControlCommand::RedownloadTask { .. } => ("redownloadTask", None),
        ControlCommand::DeleteTask { .. } => ("deleteTask", None),
        ControlCommand::MoveTask { .. } => ("moveTask", None),
        ControlCommand::SetTaskPriority { .. } => ("setTaskPriority", None),
        ControlCommand::UpdateTask { .. } => ("updateTask", None),
        ControlCommand::StartQueue { .. } => ("startQueue", None),
        ControlCommand::StopQueue { .. } => ("stopQueue", None),
        ControlCommand::CreateQueue { .. } => ("createQueue", None),
        ControlCommand::UpdateQueue { .. } => ("updateQueue", None),
        ControlCommand::DeleteQueue { .. } => ("deleteQueue", None),
        ControlCommand::ReorderQueues { .. } => ("reorderQueues", None),
        ControlCommand::ReorderQueueTasks { .. } => ("reorderQueueTasks", None),
        ControlCommand::SetActiveProfile { .. } => ("setActiveProfile", None),
        ControlCommand::UpsertProfile { .. } => ("upsertProfile", None),
        ControlCommand::DeleteProfile { .. } => ("deleteProfile", None),
        ControlCommand::AddRule { .. } => ("addRule", None),
        ControlCommand::DeleteRule { .. } => ("deleteRule", None),
        ControlCommand::AddSchedule { .. } => ("addSchedule", None),
        ControlCommand::UpdateSchedule { .. } => ("updateSchedule", None),
        ControlCommand::DeleteSchedule { .. } => ("deleteSchedule", None),
        ControlCommand::SetSchedulerPowerCommands { .. } => ("setSchedulerPowerCommands", None),
    };
    ensure_capability_supported(capabilities, capability_id)?;
    if let Some(runtime_capability_id) = runtime_capability_id {
        ensure_runtime_entry_supported(capabilities, runtime_capability_id)?;
    }
    Ok(())
}

fn ensure_runtime_entry_supported(
    capabilities: &serde_json::Value,
    capability_id: &str,
) -> Result<(), String> {
    let entries = capabilities
        .pointer("/capabilityRegistry/entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "runtime did not provide its unified capability registry".to_owned())?;
    let status = entries
        .iter()
        .find(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(capability_id))
        .and_then(|entry| entry.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unavailable");
    if status == "supported" {
        Ok(())
    } else {
        Err(format!("runtime capability `{capability_id}` is {status}"))
    }
}

fn ensure_capability_supported(
    capabilities: &serde_json::Value,
    capability_id: &str,
) -> Result<(), String> {
    let entries = capabilities
        .pointer("/controlPlane/commandCapabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "runtime did not provide its command capability registry".to_owned())?;
    let status = entries
        .iter()
        .find(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(capability_id))
        .and_then(|entry| entry.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unavailable");
    if status == "supported" {
        Ok(())
    } else {
        Err(format!("runtime capability `{capability_id}` is {status}"))
    }
}

fn ensure_query_available(
    capabilities: &serde_json::Value,
    query: &ControlQuery,
) -> Result<(), String> {
    let query_id = match query {
        ControlQuery::Capabilities => return Ok(()),
        ControlQuery::ListQueues => "listQueues",
        ControlQuery::ListProfiles => "listProfiles",
        ControlQuery::GetProfile { .. } => "getProfile",
        ControlQuery::ListRules => "listRules",
        ControlQuery::ListSchedules => "listSchedules",
        ControlQuery::ListTasks { .. } => "listTasks",
        ControlQuery::Diagnostics => "diagnostics",
        ControlQuery::RecentLogs { .. } => "recentLogs",
        ControlQuery::GetTask { .. } => "getTask",
        ControlQuery::Events { .. } => "events",
    };
    let entries = capabilities
        .pointer("/controlPlane/queryCapabilities")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "runtime did not provide its query capability registry".to_owned())?;
    let status = entries
        .iter()
        .find(|entry| entry.get("id").and_then(serde_json::Value::as_str) == Some(query_id))
        .and_then(|entry| entry.get("status"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unavailable");
    if status == "supported" {
        Ok(())
    } else {
        Err(format!("runtime query `{query_id}` is {status}"))
    }
}

fn validate_local_url(raw: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(raw).map_err(|error| format!("invalid NOVA URL: {error}"))?;
    let local_host = matches!(
        parsed.host_str(),
        Some("127.0.0.1" | "localhost" | "::1")
    );
    if parsed.scheme() != "http"
        || !local_host
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
    {
        return Err("the CLI currently accepts only a local HTTP daemon URL; remote control is not enabled".to_owned());
    }
    Ok(())
}

fn get_capabilities(
    client: &reqwest::blocking::Client,
    base_url: &str,
    token: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/api/engine/capabilities", base_url.trim_end_matches('/'));
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|error| format!("cannot reach the local daemon: {error}"))?;
    read_response(response)
}

fn post_json<T: serde::Serialize>(
    client: &reqwest::blocking::Client,
    base_url: &str,
    token: &str,
    path: &str,
    body: &T,
) -> Result<serde_json::Value, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let response = client
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .map_err(|error| format!("request to the local daemon failed: {error}"))?;
    read_response(response)
}

fn read_response(response: reqwest::blocking::Response) -> Result<serde_json::Value, String> {
    let status = response.status();
    let body = response
        .json::<serde_json::Value>()
        .map_err(|error| format!("daemon returned an invalid JSON response: {error}"))?;
    if !status.is_success() {
        let error = body
            .pointer("/error/message")
            .or_else(|| body.get("error"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("request rejected");
        return Err(format!("daemon returned HTTP {status}: {error}"));
    }
    Ok(body)
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn print_help() {
    println!(
        "NOVA CLI (local Control Plane client)\n\
         Environment: NOVA_API_TOKEN (required), NOVA_API_URL (default http://127.0.0.1:3199), NOVA_IDEMPOTENCY_KEY (optional)\n\
         Commands:\n\
         add <url> | list | inspect <task-id> | pause|resume|retry|redownload <task-id> | delete <task-id> [--files]\n\
         move <task-id> <queue-id> | priority <task-id> <0-4> | update <task-id> <json>\n\
         queue list|start|stop|create|update|delete|order|task-order ...\n\
         profile list|get|set|upsert|delete ... | rules list|add|delete ...\n\
         schedule list|add|update|delete|power ... | media add|playlist ... | torrent add <json>\n\
         events [cursor] | batch <json-command-array> | capabilities\n\
         Commands accept --idempotency-key <key> so retries after a timeout do not repeat mutations.\n\
         diagnostics | logs [limit] [trace|debug|info|warn|error] | network/config (runtime capability dependent)."
    );
}
