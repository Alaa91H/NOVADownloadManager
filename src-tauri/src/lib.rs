// The runtime engine-capability snapshot builds a large `serde_json::json!`
// object literal (see daemon::engine_capabilities), which expands past the
// default macro recursion limit of 128.
#![recursion_limit = "512"]

use serde::Serialize;
use std::net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

const DEFAULT_DAEMON_PORT: u16 = 3199;
const DAEMON_PORT_SCAN_LIMIT: u16 = 30;
const TAURI_CONFIG_JSON: &str = include_str!("../tauri.conf.json");

fn validate_file_path(path: &str) -> Result<PathBuf, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_owned());
    }
    let target = PathBuf::from(path);
    if target
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err("Path traversal detected".to_owned());
    }
    // Reject UNC paths (\\server\share\...) to prevent network share access.
    if let Some(first) = target.to_str().and_then(|s| s.chars().next()) {
        if first == '\\' {
            return Err("UNC paths are not allowed".to_owned());
        }
    }
    // Accept targets whose parent exists even if the file doesn't (new downloads).
    if target.exists() {
        target
            .canonicalize()
            .map_err(|_| "Path does not exist or is inaccessible".to_owned())
    } else if let Some(parent) = target.parent().filter(|p| !p.as_os_str().is_empty()) {
        if parent.exists() {
            Ok(target)
        } else {
            Err("Path does not exist or is inaccessible".to_owned())
        }
    } else {
        Err("Path does not exist or is inaccessible".to_owned())
    }
}

mod daemon;
pub mod logging;
pub mod native_host;
pub(crate) use daemon::utils::hide_command_window;
pub use native_host::{is_native_messaging_launch, run_native_messaging_host};

struct DaemonUrl(Mutex<String>);

#[derive(Serialize)]
struct BrowserExtensionPaths {
    dev_path: String,
    resource_path: String,
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdaterConfigurationStatus {
    configured: bool,
    message: Option<&'static str>,
}

/// Do not invoke the updater plugin with repository placeholder values. The
/// updater is only safe to use after a release endpoint and the matching
/// public signing key have both been compiled into the application.
#[tauri::command]
fn get_updater_configuration_status() -> UpdaterConfigurationStatus {
    let placeholders_present = TAURI_CONFIG_JSON.contains("__UPDATER_ENDPOINT__")
        || TAURI_CONFIG_JSON.contains("__UPDATER_PUBKEY__");
    UpdaterConfigurationStatus {
        configured: !placeholders_present,
        message: placeholders_present.then_some(
            "Signed in-app updates are not configured for this build. Use the official release page instead.",
        ),
    }
}

#[tauri::command]
fn get_daemon_url(state: tauri::State<DaemonUrl>) -> String {
    state.0.lock().map_or_else(
        |_| format!("http://127.0.0.1:{DEFAULT_DAEMON_PORT}"),
        |g| g.clone(),
    )
}

/// Return the daemon's API bearer token so the trusted desktop webview can
/// authenticate its HTTP calls to the local service.
#[tauri::command]
fn get_daemon_token() -> String {
    daemon::shared_api_token()
}

fn requested_daemon_port() -> u16 {
    std::env::var("NOVA_DAEMON_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|&p| p >= 1024)
        .unwrap_or(DEFAULT_DAEMON_PORT)
}

fn is_loopback_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn find_available_daemon_port(preferred_port: u16) -> u16 {
    if is_loopback_port_available(preferred_port) {
        return preferred_port;
    }

    for offset in 1..=DAEMON_PORT_SCAN_LIMIT {
        let Some(port) = preferred_port.checked_add(offset) else {
            break;
        };
        if is_loopback_port_available(port) {
            log::warn!(
                "Preferred NOVA daemon port {preferred_port} is unavailable; using {port} instead"
            );
            return port;
        }
    }

    // Asking the OS for port 0 is both faster and more reliable than a second
    // bounded scan of the ephemeral range. The previous loop advertised a
    // full-range scan but stopped after the same small failure limit.
    match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => match listener.local_addr() {
            Ok(addr) if addr.port() != 0 => {
                log::warn!(
                    "No free daemon port found near {preferred_port}; using OS-assigned loopback port {}",
                    addr.port()
                );
                addr.port()
            }
            _ => preferred_port,
        },
        Err(error) => {
            log::warn!(
                "Could not allocate an OS-assigned loopback port after {preferred_port} was unavailable: {error}"
            );
            // Absolute last resort — let the bind fail naturally.
            preferred_port
        }
    }
}

fn daemon_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn set_daemon_url(state: &tauri::State<DaemonUrl>, port: u16) {
    match state.0.lock() {
        Ok(mut url) => *url = daemon_url_for_port(port),
        Err(error) => log::error!("Could not update daemon URL state: {error}"),
    }
}

#[tauri::command]
fn get_downloads_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("Could not resolve downloads directory: {e}"))
}

#[tauri::command]
fn get_desktop_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .desktop_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("Could not resolve desktop directory: {e}"))
}

#[tauri::command]
fn get_browser_extension_paths(app: tauri::AppHandle) -> BrowserExtensionPaths {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest_dir
        .parent()
        .unwrap_or(Path::new("."))
        .join("browser-extension");
    let resource_path = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| {
            let pf =
                std::env::var("PROGRAMFILES").unwrap_or_else(|_| r"C:\Program Files".to_owned());
            PathBuf::from(format!(r"{pf}\Nova Download Manager\resources"))
        })
        .join("browser-extension");

    BrowserExtensionPaths {
        dev_path: dev_path.display().to_string(),
        resource_path: resource_path.display().to_string(),
    }
}

#[tauri::command]
fn open_extension_folder(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Err("Extension folder was not found.".to_owned());
    }
    open_with_explorer(&target)
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    // validate_file_path already canonicalizes, and explorer.exe handles \\?\ paths.
    let mut launcher = Command::new("explorer.exe");
    hide_command_window(&mut launcher);
    launcher
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open downloaded file: {error}"))
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    if target.is_dir() {
        return open_with_explorer(&target);
    }

    if target.is_file() {
        let select_arg = format!("/select,{}", target.display());
        let mut launcher = Command::new("explorer.exe");
        hide_command_window(&mut launcher);
        launcher
            .arg(&select_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("Could not reveal downloaded file: {error}"))
    } else if let Some(parent) = target.parent().filter(|parent| parent.exists()) {
        open_with_explorer(parent)
    } else {
        Err("Downloaded file location was not found.".to_owned())
    }
}

#[tauri::command]
fn delete_downloaded_file(path: String) -> Result<bool, String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Ok(false);
    }
    if !target.is_file() {
        return Err("Refusing to delete a folder from the single-file delete action.".to_owned());
    }

    std::fs::remove_file(&target)
        .map(|()| true)
        .map_err(|error| format!("Could not delete downloaded file: {error}"))
}

#[tauri::command]
fn scan_downloaded_file(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Err("Downloaded file was not found.".to_owned());
    }
    if !target.is_file() {
        return Err("The selected download path is not a file.".to_owned());
    }

    let mut scanner = Command::new("powershell");
    hide_command_window(&mut scanner);
    scanner
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$path = Resolve-Path -LiteralPath $args[0] -ErrorAction Stop; Start-MpScan -ScanType CustomScan -ScanPath $path",
        ])
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start antivirus scan: {error}"))
}

#[tauri::command]
fn open_browser_extensions(browser: String) -> Result<(), String> {
    let (command, url) = match browser.as_str() {
        "chrome" => ("chrome.exe", "chrome://extensions"),
        "edge" => ("msedge.exe", "edge://extensions"),
        "firefox" => ("firefox.exe", "about:debugging#/runtime/this-firefox"),
        _ => return Err("Unsupported browser.".to_owned()),
    };

    let mut launcher = Command::new("cmd");
    hide_command_window(&mut launcher);
    launcher
        .args(["/C", "start", "", command, url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open browser extensions page: {error}"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("Only web links can be opened.".to_owned());
    }
    // Parse the URL properly to handle IPv6 brackets, decimal IPs, etc.
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let host_str = parsed.host_str().unwrap_or("");
    // Strip IPv6 brackets for IP checks
    let host_clean = host_str.trim_start_matches('[').trim_end_matches(']');
    let is_internal = match host_clean {
        "localhost" | "127.0.0.1" | "0.0.0.0" | "::1" => true,
        h if h.starts_with("192.168.") || h.starts_with("10.") => true,
        h if h.starts_with("172.") => h
            .split('.')
            .nth(1)
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|octet| (16..=31).contains(&octet)),
        h if h.starts_with("169.254.") => true,
        // Handle IPv6 ULA (fc00::/7), link-local (fe80::/10), loopback (::1)
        h if h.starts_with("fc") || h.starts_with("fd") => true,
        h if h.starts_with("fe80") => true,
        _ => false,
    };
    // Also check the host as a raw IP via std::net to catch IPv4-mapped IPv6
    // (e.g. [::ffff:127.0.0.1]) and decimal/hex encodings.
    if !is_internal {
        use std::net::IpAddr;
        if let Ok(ip) = host_clean.parse::<IpAddr>() {
            if ip.is_loopback()
                || ip.is_unspecified()
                || match ip {
                    IpAddr::V4(v) => v.is_private() || v.is_link_local() || v.is_broadcast(),
                    IpAddr::V6(v) => {
                        v.segments()[0] & 0xfe00 == 0xfc00 // ULA
                            || v.segments()[0] == 0xfe80    // link-local
                            || v == std::net::Ipv6Addr::LOCALHOST
                    }
                }
            {
                return Err("Internal URLs cannot be opened in the browser.".to_owned());
            }
        }
    }
    if is_internal {
        return Err("Internal URLs cannot be opened in the browser.".to_owned());
    }
    // Re-serialize through reqwest::Url to strip any embedded shell metacharacters
    let clean_url = parsed.as_str().to_owned();
    let mut launcher = Command::new("rundll32.exe");
    hide_command_window(&mut launcher);
    launcher
        .args(["url.dll,FileProtocolHandler", &clean_url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open link: {error}"))
}

#[tauri::command]
fn check_tcp_endpoint(host: String, port: u16) -> Result<bool, String> {
    if host.trim().is_empty() {
        return Err("Host is required.".to_owned());
    }
    let address = format!("{}:{}", host.trim(), port);
    let (tx, rx) = std::sync::mpsc::channel();
    let dns_host = address;
    std::thread::spawn(move || {
        let result = (|| -> Result<Vec<std::net::SocketAddr>, String> {
            let resolved: Vec<_> = dns_host
                .to_socket_addrs()
                .map_err(|e| e.to_string())?
                .collect();
            if resolved.is_empty() {
                return Err("No addresses resolved".to_owned());
            }
            // Check ALL resolved addresses are safe, not just the first one
            for addr in &resolved {
                if crate::daemon::utils::is_internal_ip(addr.ip()) {
                    return Err(format!(
                        "Connections to internal/local addresses are not allowed: {}",
                        addr.ip()
                    ));
                }
            }
            Ok(resolved)
        })();
        let _ = tx.send(result);
    });
    let resolved = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(addrs)) => addrs,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Could not resolve endpoint: timeout".to_owned()),
    };
    // Connect to the first resolved address (all were verified safe)
    Ok(TcpStream::connect_timeout(&resolved[0], Duration::from_millis(1200)).is_ok())
}

#[tauri::command]
fn validate_source_address(address: String) -> Result<bool, String> {
    let parsed: IpAddr = address
        .trim()
        .parse()
        .map_err(|_| "Enter a valid IP address for the VPN adapter.".to_owned())?;

    // Reject link-local and loopback addresses which are never valid VPN adapters
    if parsed.is_loopback()
        || parsed.is_unspecified()
        || match parsed {
            IpAddr::V4(v) => v.is_link_local() || v.is_broadcast(),
            IpAddr::V6(_) => false,
        }
    {
        return Err(
            "Link-local and loopback addresses are not valid VPN adapter addresses.".to_owned(),
        );
    }

    #[cfg(windows)]
    {
        let script =
            "if (Get-NetIPAddress -IPAddress (\"$($args[0])\" -as [System.Net.IPAddress]) -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }";
        let mut command = Command::new("powershell");
        hide_command_window(&mut command);
        let output = command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .arg(parsed.to_string())
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Could not inspect network adapters: {error}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).contains("yes"))
    }

    #[cfg(not(windows))]
    {
        let socket = std::net::SocketAddr::new(parsed, 0);
        Ok(TcpListener::bind(socket).is_ok())
    }
}

#[tauri::command]
fn detect_vpn_interface() -> Result<bool, String> {
    #[cfg(windows)]
    {
        let script = r"
$pattern = 'VPN|WireGuard|Wintun|TAP|TUN|OpenVPN|Nord|Proton|Mullvad|Surfshark|Cisco|AnyConnect|Fortinet|GlobalProtect|ZeroTier|Tailscale|WAN Miniport|IKEv2|L2TP|PPTP'
$adapter = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and ($_.Name -match $pattern -or $_.InterfaceDescription -match $pattern)
} | Select-Object -First 1
if ($adapter) { 'yes' } else { 'no' }
";
        let mut command = Command::new("powershell");
        hide_command_window(&mut command);
        let output = command
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Could not inspect VPN adapters: {error}"))?;
        Ok(String::from_utf8_lossy(&output.stdout).contains("yes"))
    }

    #[cfg(not(windows))]
    {
        Ok(false)
    }
}

fn open_with_explorer(path: &Path) -> Result<(), String> {
    let mut launcher = Command::new("explorer.exe");
    hide_command_window(&mut launcher);
    launcher
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open folder: {error}"))
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    const MAX_CONFIG_SIZE: usize = 1024 * 1024;
    if settings.len() > MAX_CONFIG_SIZE {
        return Err(format!(
            "Config size ({} bytes) exceeds limit ({} bytes)",
            settings.len(),
            MAX_CONFIG_SIZE
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&settings).map_err(|e| format!("Invalid JSON config: {e}"))?;
    if !parsed.is_object() {
        return Err("Config must be a JSON object".to_owned());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let config_path = data_dir.join("config.json");
    let tmp_path = data_dir.join("config.json.tmp");
    std::fs::write(&tmp_path, &settings).map_err(|e| format!("Failed to save config: {e}"))?;
    std::fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("Failed to atomically replace config: {e}"))
}

/// Write a text file to a user-selected location (e.g. exported log files).
/// The path is picked through the native save dialog, so it is treated as a
/// trusted destination, but we still guard against empty/relative targets.
#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    const MAX_FILE_SIZE: usize = 64 * 1024 * 1024;
    if path.trim().is_empty() {
        return Err("File path is required.".to_owned());
    }
    if content.len() > MAX_FILE_SIZE {
        return Err(format!(
            "File content ({} bytes) exceeds limit ({} bytes)",
            content.len(),
            MAX_FILE_SIZE
        ));
    }
    let target = std::path::PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("File path must be absolute.".to_owned());
    }
    let parent = target
        .parent()
        .ok_or_else(|| "File path has no parent directory.".to_owned())?;
    if !parent.is_dir() {
        return Err(format!(
            "Destination folder does not exist: {}",
            parent.display()
        ));
    }
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if file_name.trim().is_empty() {
        return Err("File path has no file name.".to_owned());
    }
    let tmp_path = parent.join(format!(".{file_name}.tmp"));
    std::fs::write(&tmp_path, &content).map_err(|e| format!("Failed to write log file: {e}"))?;
    if std::fs::rename(&tmp_path, &target).is_err() {
        // Cross-device or locked destination fallback: overwrite in place.
        let _ = std::fs::remove_file(&tmp_path);
        std::fs::write(&target, &content).map_err(|e| format!("Failed to write log file: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn restart_daemon(
    app: tauri::AppHandle,
    daemon_url: tauri::State<DaemonUrl>,
) -> Result<(), String> {
    log::info!("NOVA daemon restart requested");
    // Signal the running daemon to shut down gracefully (saves state, etc.).
    crate::daemon::signal_shutdown();
    std::thread::sleep(std::time::Duration::from_millis(800));
    // M-3: kill only the recorded daemon PID (read from the port file) instead
    // of spawning a PowerShell process for every port in the scan range, which
    // froze the UI for seconds. Fall back to the range scan only when no PID
    // is on file.
    let our_pid = std::process::id();
    let preferred = requested_daemon_port();
    if !kill_pid_from_port_file(our_pid) {
        kill_old_daemon_range(our_pid, preferred);
    }
    let port = find_available_daemon_port(requested_daemon_port());
    set_daemon_url(&daemon_url, port);
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .display()
        .to_string();
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .display()
        .to_string();
    daemon::start_daemon(resource_dir, data_dir, port);
    Ok(())
}

/// Read the daemon PID recorded in the port file and kill it. Returns true
/// when a PID was found (and killed); false means the caller should fall back
/// to scanning the port range.
fn kill_pid_from_port_file(our_pid: u32) -> bool {
    let data_dir = std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_owned());
    let data_dir = std::path::Path::new(&data_dir).join("nova-download-manager");
    let port_file = data_dir.join("nova-daemon.port");
    if let Ok(content) = std::fs::read_to_string(&port_file) {
        let lines: Vec<&str> = content.lines().collect();
        if lines.len() >= 2 {
            if let Ok(old_pid) = lines[1].trim().parse::<u32>() {
                if old_pid != 0 && old_pid != our_pid {
                    crate::daemon::utils::kill_process(old_pid);
                    return true;
                }
            }
        }
    }
    false
}

/// Kill any orphaned daemon process by reading the stored PID from the port file,
/// or fall back to scanning the port range. Non-blocking: spawns a background thread.
fn kill_old_daemon() {
    let our_pid = std::process::id();
    let preferred = requested_daemon_port();
    std::thread::spawn(move || {
        if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Prefer the recorded PID; fall back to scanning the port range.
            if !kill_pid_from_port_file(our_pid) {
                kill_old_daemon_range(our_pid, preferred);
            }
        })) {
            let msg = if let Some(s) = e.downcast_ref::<&str>() {
                (*s).to_owned()
            } else if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown".to_owned()
            };
            log::error!("kill_old_daemon thread panicked: {msg}");
        }
    });
}

/// Blocking: kills processes on a range of ports.
fn kill_old_daemon_range(our_pid: u32, preferred: u16) {
    for offset in 0..=DAEMON_PORT_SCAN_LIMIT {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };
        let script = format!(
            "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue \
             | ForEach-Object {{ \
                $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \
                if ($p -and $p.Id -ne {our_pid} -and $p.ProcessName -match 'NOVA') {{ \
                    taskkill /F /PID $p.Id -ErrorAction SilentlyContinue \
                }} \
            }}",
        );
        let mut command = Command::new("powershell");
        hide_command_window(&mut command);
        let _ = command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
}

#[must_use]
pub fn is_integration_mode() -> bool {
    std::env::args().any(|arg| arg == "--integration" || arg == "--background")
}

pub fn run_integration_mode() {
    let preferred_port = std::env::var("NOVA_DAEMON_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|&p| p >= 1024)
        .unwrap_or(3199u16);

    let port = find_available_daemon_port(preferred_port);

    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string();

    let data_dir = {
        let home = std::env::var("APPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_owned());
        format!("{home}/nova-download-manager")
    };

    log::info!("Integration mode: starting daemon on port {port} (no GUI)");
    daemon::start_daemon(resource_dir, data_dir, port);

    // Keep the process alive
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            kill_old_daemon();
            let default_port = requested_daemon_port();
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            loop {
                if is_loopback_port_available(default_port) {
                    break;
                }
                if std::time::Instant::now() > deadline {
                    log::warn!(
                        "Daemon port {default_port} still not available after 2s; starting anyway"
                    );
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let startup_port = find_available_daemon_port(default_port);
            let default_url = daemon_url_for_port(startup_port);
            app.manage(DaemonUrl(Mutex::new(default_url)));

            // Start the Rust daemon (spawns its own background thread)
            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .display()
                .to_string();
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .display()
                .to_string();
            daemon::start_daemon(resource_dir, data_dir, startup_port);

            let show = MenuItem::with_id(app, "show", "Show NOVA", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

            let tray_icon = app.default_window_icon().cloned().unwrap_or_else(|| {
                log::warn!("No default window icon found, using empty icon");
                tauri::image::Image::new(&[], 0, 0)
            });
            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("NOVA Download Manager")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        log::info!("Shutting down NOVA daemon...");
                        crate::daemon::signal_shutdown();
                        std::thread::sleep(std::time::Duration::from_millis(800));
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Err(e) = window.hide() {
                    log::error!("Failed to hide window: {e}");
                }
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_updater_configuration_status,
            get_daemon_url,
            get_daemon_token,
            get_downloads_dir,
            get_desktop_dir,
            get_browser_extension_paths,
            open_extension_folder,
            open_file,
            reveal_file,
            delete_downloaded_file,
            scan_downloaded_file,
            open_browser_extensions,
            open_external_url,
            check_tcp_endpoint,
            validate_source_address,
            detect_vpn_interface,
            save_config,
            write_text_file,
            restart_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod port_selection_tests {
    use super::*;

    #[test]
    fn occupied_preferred_port_selects_a_different_loopback_port() {
        let occupied =
            TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).expect("bind test port");
        let preferred = occupied.local_addr().expect("read test port").port();

        let selected = find_available_daemon_port(preferred);

        assert_ne!(selected, preferred);
        assert!(selected >= 1024);
    }

    #[test]
    fn updater_status_rejects_repository_placeholder_configuration() {
        let status = get_updater_configuration_status();

        assert!(!status.configured);
        assert!(status
            .message
            .is_some_and(|message| message.contains("not configured")));
    }
}
