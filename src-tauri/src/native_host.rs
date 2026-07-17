use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::time::Duration;

const LOOPBACK_BASE_URL: &str = "http://127.0.0.1:3199";
const MAX_NATIVE_REQUEST_BYTES: u32 = 16 * 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES: usize = 1024 * 1024;

pub fn is_native_messaging_launch() -> bool {
    std::env::args().skip(1).any(|arg| {
        arg == "--native-host"
            || arg.starts_with("chrome-extension://")
            || arg.starts_with("moz-extension://")
            || arg.starts_with("--parent-window=")
            || arg.ends_with("com.nova.downloadmanager.json")
    })
}

pub fn run_native_messaging_host() {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = write_native_message(&json!({
                "id": "startup",
                "ok": false,
                "error": { "code": "NATIVE_HOST_INIT_FAILED", "message": error.to_string(), "retryable": false }
            }));
            return;
        }
    };

    while let Ok(message) = read_native_message() {
        let response = handle_native_request(&client, message);
        if write_native_message(&response).is_err() {
            break;
        }
    }
}

fn read_native_message() -> io::Result<Value> {
    let mut len_buf = [0_u8; 4];
    io::stdin().read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf);
    if len == 0 || len > MAX_NATIVE_REQUEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message size is invalid",
        ));
    }
    let mut body = vec![0_u8; len as usize];
    io::stdin().read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_native_message(value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if bytes.len() > MAX_NATIVE_RESPONSE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native response exceeds browser limit",
        ));
    }
    let len = (bytes.len() as u32).to_le_bytes();
    let mut stdout = io::stdout();
    stdout.write_all(&len)?;
    stdout.write_all(&bytes)?;
    stdout.flush()
}

fn handle_native_request(client: &reqwest::blocking::Client, request: Value) -> Value {
    let id = request
        .get("id")
        .cloned()
        .unwrap_or_else(|| json!("unknown"));
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    let result = match method {
        "engine.status" => http_json(client, "GET", "/v1/ping", None),
        "task.list" => http_json(client, "GET", "/v1/tasks", None),
        "task.pause" => task_command(client, "/v1/task/pause", params),
        "task.resume" => task_command(client, "/v1/task/resume", params),
        "task.cancel" => task_command(client, "/v1/task/cancel", params),
        "candidate.send" => http_json(client, "POST", "/v1/add", Some(params)),
        "candidate.batch" => http_json(client, "POST", "/captures", Some(params)),
        "stream.resolve" => http_json(client, "POST", "/v1/stream/resolve", Some(params)),
        "stream.add" => http_json(client, "POST", "/v1/stream/add", Some(params)),
        "analyze.start" => http_json(client, "POST", "/v1/analyze", Some(params)),
        "probe.ytdlp" => {
            let url_param = params.get("url").and_then(Value::as_str).unwrap_or("");
            let encoded: String = url_param
                .bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{:02X}", b),
                })
                .collect();
            let route = format!("/api/ytdlp/probe?url={}", encoded);
            http_json(client, "GET", &route, None)
        }
        "capabilities" => http_json(client, "GET", "/api/engines/capabilities", None),
        "external.tools" => http_json(client, "GET", "/api/external-tools", None),
        _ => Err(format!("Unsupported native method: {method}")),
    };

    match result {
        Ok(value) => json!({ "id": id, "ok": true, "result": value }),
        Err(message) => json!({
            "id": id,
            "ok": false,
            "error": { "code": "NATIVE_PROXY_ERROR", "message": message, "retryable": true }
        }),
    }
}

fn task_command(
    client: &reqwest::blocking::Client,
    route: &str,
    params: Value,
) -> Result<Value, String> {
    let task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| "taskId is required".to_string())?;
    http_json(client, "POST", route, Some(json!({ "taskId": task_id })))
}

fn http_json(
    client: &reqwest::blocking::Client,
    method: &str,
    route: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{LOOPBACK_BASE_URL}{route}");
    let request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported loopback method: {method}")),
    };
    let request = if let Some(body) = body {
        request.json(&body)
    } else {
        request
    };
    let response = request
        .send()
        .map_err(|error| format!("NOVA loopback bridge is unavailable: {error}"))?;
    let status = response.status();
    let value = response
        .json::<Value>()
        .map_err(|error| format!("Invalid NOVA loopback response: {error}"))?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("NOVA loopback request failed")
            .to_string());
    }
    Ok(value)
}
