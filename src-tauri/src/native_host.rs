use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::sync::Mutex;
use std::time::Duration;

const DEFAULT_PORT: u16 = 3199;
const PORT_SCAN_RANGE: u16 = 10;
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

/// State shared across the native host request loop: the resolved daemon base
/// URL and the API token obtained via auto-pairing.
struct HostState {
    base_url: String,
    api_token: Option<String>,
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

    let base_url = discover_daemon_port(&client);
    let api_token = obtain_api_token(&client, &base_url);
    let state = Mutex::new(HostState {
        base_url,
        api_token,
    });

    while let Ok(message) = read_native_message() {
        let response = handle_native_request(&client, &state, message);
        if write_native_message(&response).is_err() {
            break;
        }
    }
}

/// Try to read the daemon port from the port file, then scan a range of
/// candidate ports to find a live daemon.
fn discover_daemon_port(client: &reqwest::blocking::Client) -> String {
    // 1. Try the port file written by the daemon on startup.
    if let Some(port) = read_port_file() {
        let url = format!("http://127.0.0.1:{port}");
        if ping_daemon(client, &url) {
            return url;
        }
    }

    // 2. Scan the default port and the range above it.
    for offset in 0..PORT_SCAN_RANGE {
        let port = DEFAULT_PORT.saturating_add(offset);
        let url = format!("http://127.0.0.1:{port}");
        if ping_daemon(client, &url) {
            return url;
        }
    }

    // 3. Fall back to the default port — the daemon may not be running yet.
    format!("http://127.0.0.1:{DEFAULT_PORT}")
}

/// Read the port number the daemon wrote to its well-known port file.
fn read_port_file() -> Option<u16> {
    let candidates = port_file_paths();
    for path in candidates {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(port) = content.trim().parse::<u16>() {
                if port >= 1024 {
                    return Some(port);
                }
            }
        }
    }
    None
}

/// Compute platform-specific paths where the daemon may have written its port.
/// These MUST match the directories the daemon actually uses:
/// - Tauri mode:      app_data_dir for identifier `com.nova.downloadmanager`
/// - Integration mode: `<APPDATA|HOME>/nova-download-manager`
/// Legacy `NOVA` paths are kept as a fallback for older installs.
fn port_file_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();

    // Windows — Tauri app_data_dir: %APPDATA%\com.nova.downloadmanager
    if let Ok(app_data) = std::env::var("APPDATA") {
        let base = std::path::PathBuf::from(app_data);
        paths.push(
            base.join("com.nova.downloadmanager")
                .join("nova-daemon.port"),
        );
        // Integration mode: %APPDATA%\nova-download-manager
        paths.push(
            base.join("nova-download-manager")
                .join("nova-daemon.port"),
        );
    }

    // Legacy: %LOCALAPPDATA%\NOVA\nova-daemon.port  (Windows)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        paths.push(
            std::path::PathBuf::from(local_app_data)
                .join("NOVA")
                .join("nova-daemon.port"),
        );
    }

    // Linux — Tauri app_data_dir: $XDG_DATA_HOME/com.nova.downloadmanager
    // (default ~/.local/share), integration mode: ~/nova-download-manager
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        let home = std::path::PathBuf::from(home);
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            paths.push(
                std::path::PathBuf::from(xdg)
                    .join("com.nova.downloadmanager")
                    .join("nova-daemon.port"),
            );
        }
        paths.push(
            home.join(".local")
                .join("share")
                .join("com.nova.downloadmanager")
                .join("nova-daemon.port"),
        );
        paths.push(home.join("nova-download-manager").join("nova-daemon.port"));
        // Legacy: ~/.config/NOVA/nova-daemon.port
        paths.push(
            home.join(".config")
                .join("NOVA")
                .join("nova-daemon.port"),
        );
        // macOS — Tauri app_data_dir
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("com.nova.downloadmanager")
                .join("nova-daemon.port"),
        );
        // Legacy macOS
        paths.push(
            home.join("Library")
                .join("Application Support")
                .join("NOVA")
                .join("nova-daemon.port"),
        );
    }

    paths
}

/// Quick ping to check if a daemon is listening on the given base URL.
fn ping_daemon(client: &reqwest::blocking::Client, base_url: &str) -> bool {
    let url = format!("{base_url}/v1/ping");
    match client.get(&url).send() {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Call POST /v1/pair/auto to obtain the daemon's API token. The pair endpoint
/// is exempt from auth and returns the real daemon token.
fn obtain_api_token(client: &reqwest::blocking::Client, base_url: &str) -> Option<String> {
    let url = format!("{base_url}/v1/pair/auto");
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&json!({}))
        .send()
        .ok()?;
    let value: Value = response.json().ok()?;
    value
        .get("pairToken")
        .and_then(Value::as_str)
        .map(String::from)
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

fn handle_native_request(
    client: &reqwest::blocking::Client,
    state: &Mutex<HostState>,
    request: Value,
) -> Value {
    let id = request
        .get("id")
        .cloned()
        .unwrap_or_else(|| json!("unknown"));
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    // Routes that are exempt from auth on the daemon side — no token needed.
    let needs_auth = !matches!(method, "engine.status" | "capabilities" | "external.tools");

    let result = match method {
        "engine.status" => http_json(client, state, "GET", "/v1/ping", None, false),
        "task.list" => http_json(client, state, "GET", "/v1/tasks", None, needs_auth),
        "task.pause" => task_command(client, state, "/v1/task/pause", params, needs_auth),
        "task.resume" => task_command(client, state, "/v1/task/resume", params, needs_auth),
        "task.cancel" => task_command(client, state, "/v1/task/cancel", params, needs_auth),
        "candidate.send" => http_json(client, state, "POST", "/v1/add", Some(params), needs_auth),
        "candidate.batch" => {
            http_json(client, state, "POST", "/captures", Some(params), needs_auth)
        }
        "stream.resolve" => http_json(
            client,
            state,
            "POST",
            "/v1/stream/resolve",
            Some(params),
            needs_auth,
        ),
        "stream.add" => http_json(
            client,
            state,
            "POST",
            "/v1/stream/add",
            Some(params),
            needs_auth,
        ),
        "analyze.start" => http_json(
            client,
            state,
            "POST",
            "/v1/analyze",
            Some(params),
            needs_auth,
        ),
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
            http_json(client, state, "GET", &route, None, needs_auth)
        }
        "capabilities" => http_json(
            client,
            state,
            "GET",
            "/api/engines/capabilities",
            None,
            false,
        ),
        "external.tools" => http_json(client, state, "GET", "/api/external-tools", None, false),
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
    state: &Mutex<HostState>,
    route: &str,
    params: Value,
    needs_auth: bool,
) -> Result<Value, String> {
    let task_id = params
        .get("taskId")
        .and_then(Value::as_str)
        .ok_or_else(|| "taskId is required".to_string())?;
    http_json(
        client,
        state,
        "POST",
        route,
        Some(json!({ "taskId": task_id })),
        needs_auth,
    )
}

fn http_json(
    client: &reqwest::blocking::Client,
    state: &Mutex<HostState>,
    method: &str,
    route: &str,
    body: Option<Value>,
    attach_auth: bool,
) -> Result<Value, String> {
    let base_url = {
        let guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.base_url.clone()
    };
    let url = format!("{base_url}{route}");
    let mut request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported loopback method: {method}")),
    };

    if attach_auth {
        let token = {
            let guard = state.lock().unwrap_or_else(|e| e.into_inner());
            guard.api_token.clone()
        };
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
    }

    request = if let Some(ref body) = body {
        request.json(body)
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

    // If the daemon returned 401, the token may be stale — re-pair once.
    if status == axum::http::StatusCode::UNAUTHORIZED && attach_auth {
        let new_token = {
            let base = {
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.base_url.clone()
            };
            obtain_api_token(client, &base)
        };
        if let Some(new_token) = new_token {
            {
                let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
                guard.api_token = Some(new_token.clone());
            }
            // Retry once with the refreshed token.
            let mut retry_request = match method {
                "GET" => client.get(&url),
                "POST" => client.post(&url),
                _ => return Err(format!("Unsupported loopback method: {method}")),
            };
            retry_request = retry_request.header("Authorization", format!("Bearer {new_token}"));
            retry_request = if let Some(ref body) = body {
                retry_request.json(body)
            } else {
                retry_request
            };
            let retry_response = retry_request
                .send()
                .map_err(|error| format!("NOVA loopback retry failed: {error}"))?;
            let retry_status = retry_response.status();
            let retry_value = retry_response
                .json::<Value>()
                .map_err(|error| format!("Invalid NOVA loopback retry response: {error}"))?;
            if !retry_status.is_success() {
                return Err(retry_value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("NOVA loopback request failed")
                    .to_string());
            }
            return Ok(retry_value);
        }
    }

    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("NOVA loopback request failed")
            .to_string());
    }
    Ok(value)
}
