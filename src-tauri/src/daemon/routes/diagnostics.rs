use axum::extract::State;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use std::time::Duration;
use std::time::Instant;

use crate::daemon::curl::curl_version;
use crate::daemon::state::SharedState;

use super::common::hidden_output;
static DAEMON_START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

pub fn record_daemon_start() {
    DAEMON_START.get_or_init(Instant::now);
}

pub fn process_memory_usage_mb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                if let Some(rest) = line.strip_prefix("VmRSS:") {
                    let kb = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    return kb / 1024;
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        // Measure the daemon process directly via GetProcessMemoryInfo instead
        // of spawning PowerShell (which previously reported the helper's own
        // memory, not the daemon's).
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let mut pmc: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) };
        if ok != 0 && pmc.WorkingSetSize > 0 {
            return (pmc.WorkingSetSize / 1024 / 1024) as u64;
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) =
            hidden_output("ps", &["-o", "rss=", "-p", &std::process::id().to_string()])
        {
            if output.status.success() {
                let kb = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
                return kb / 1024;
            }
        }
    }
    0
}

fn disk_free_gb(path: &str) -> u64 {
    #[cfg(target_os = "windows")]
    {
        let script = "$p=$args[0]; $drive=(Get-Item -LiteralPath $p).PSDrive; [math]::Round($drive.Free / 1GB)";
        if let Ok(output) = hidden_output(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", script, path],
        ) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = hidden_output("df", &["-Pk", path]) {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(line) = text.lines().nth(1) {
                    let kb = line
                        .split_whitespace()
                        .nth(3)
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    return kb / 1024 / 1024;
                }
            }
        }
    }
    0
}

fn network_interfaces() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = hidden_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike '169.254*'} | ForEach-Object { $_.InterfaceAlias + '=' + $_.IPAddress }"]) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = hidden_output(
            "sh",
            &[
                "-c",
                "(ip -o -4 addr show 2>/dev/null || ifconfig 2>/dev/null) | head -n 40",
            ],
        ) {
            if output.status.success() {
                return String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect();
            }
        }
    }
    Vec::new()
}

pub async fn handle_diagnostics(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let media_jobs_count = state.native_media_jobs.lock().map_or(0, |j| j.len());
    let curl_jobs_count = state.curl_jobs.lock().map_or(0, |j| j.len());
    let uptime_secs = DAEMON_START.get().map_or(0, |t| t.elapsed().as_secs());
    let engine_caps = state.engine_capabilities();
    let curl_available = engine_caps
        .pointer("/engines/curl/available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let media_available = engine_caps
        .pointer("/engines/media/available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let ffmpeg_available = engine_caps
        .pointer("/engines/ffmpeg/available")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);

    // Run full E2E diagnostics (with timeout)
    let diag = tokio::time::timeout(
        Duration::from_secs(45),
        crate::daemon::diagnostics::full_diagnostics(
            process_memory_usage_mb(),
            disk_free_gb(&state.data_dir),
            media_jobs_count + curl_jobs_count,
            curl_available,
            curl_version(),
            media_available,
            ffmpeg_available,
            network_interfaces(),
            uptime_secs,
            media_jobs_count,
            curl_jobs_count,
        ),
    )
    .await
    .unwrap_or_else(|_| {
        serde_json::json!({
            "summary": { "status": "timeout" },
            "error": "E2E diagnostics timed out after 45s"
        })
    });

    Json(diag)
}

pub async fn handle_post_diagnostics(
    State(state): State<SharedState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    log::info!(
        "Diagnostics received: {}",
        serde_json::to_string(&body).unwrap_or_default()
    );

    // Save report to file if requested
    if body
        .get("save")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S");
        let filename = format!("nova-diagnostics-{timestamp}.json");
        let report_path = std::path::Path::new(&state.data_dir)
            .join("diagnostics")
            .join(&filename);
        if let Some(parent) = report_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::write(
            &report_path,
            serde_json::to_string_pretty(&body).unwrap_or_default(),
        ) {
            Ok(()) => {
                return Json(serde_json::json!({
                    "ok": true,
                    "saved": true,
                    "path": report_path.to_string_lossy(),
                    "filename": filename
                }));
            }
            Err(e) => {
                log::warn!("Failed to save diagnostics report: {e}");
                return Json(serde_json::json!({
                    "ok": true,
                    "saved": false,
                    "error": format!("Failed to save: {}", e)
                }));
            }
        }
    }

    Json(serde_json::json!({"ok": true}))
}

pub fn register_routes(router: Router<SharedState>) -> Router<SharedState> {
    router.route(
        "/api/diagnostics",
        get(handle_diagnostics).post(handle_post_diagnostics),
    )
}
