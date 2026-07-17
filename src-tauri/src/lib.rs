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

fn validate_file_path(path: &str) -> Result<PathBuf, String> {
    if path.contains('\0') {
        return Err("Invalid path".to_string());
    }
    let target = PathBuf::from(path);
    if target
        .components()
        .any(|c| c == std::path::Component::ParentDir)
    {
        return Err("Path traversal detected".to_string());
    }
    if target.is_absolute() && target.is_file() {
        let canonical = target
            .canonicalize()
            .map_err(|_| "Path does not exist".to_string())?;
        Ok(canonical)
    } else {
        Ok(target)
    }
}

mod daemon;
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
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_daemon_url(state: tauri::State<DaemonUrl>) -> String {
    state
        .0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| format!("http://127.0.0.1:{}", DEFAULT_DAEMON_PORT))
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
                "Preferred NOVA daemon port {} is unavailable; using {} instead",
                preferred_port,
                port
            );
            return port;
        }
    }

    log::warn!(
        "No free daemon port found near {}; falling back to the preferred port and letting the daemon report bind errors",
        preferred_port
    );
    preferred_port
}

fn daemon_url_for_port(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

fn set_daemon_url(state: &tauri::State<DaemonUrl>, port: u16) {
    match state.0.lock() {
        Ok(mut url) => *url = daemon_url_for_port(port),
        Err(error) => log::error!("Could not update daemon URL state: {}", error),
    }
}

#[tauri::command]
fn get_downloads_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .download_dir()
        .map(|p| p.display().to_string())
        .map_err(|e| format!("Could not resolve downloads directory: {}", e))
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
                std::env::var("PROGRAMFILES").unwrap_or_else(|_| r"C:\Program Files".to_string());
            PathBuf::from(format!(r"{}\Nova Download Manager\resources", pf))
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
        return Err("Extension folder was not found.".to_string());
    }
    open_with_explorer(&target)
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Err("Downloaded file was not found.".to_string());
    }
    if !target.is_file() {
        return Err("The selected download path is not a file.".to_string());
    }

    // Use canonicalized UNC path (\\?\...) to bypass cmd.exe shell parsing
    // entirely, preventing shell metacharacter injection via crafted filenames.
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("Could not resolve file path: {e}"))?;
    let unc_path = format!(r"\\?\{}", canonical.display());

    let mut launcher = Command::new("cmd");
    hide_command_window(&mut launcher);
    launcher
        .args(["/C", "start", "", &unc_path])
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
    if target.exists() && target.is_dir() {
        return open_with_explorer(&target);
    }

    if target.exists() && target.is_file() {
        // Use canonicalized UNC path to bypass shell metacharacter injection.
        let canonical = target
            .canonicalize()
            .map_err(|e| format!("Could not resolve file path: {e}"))?;
        let unc_path = format!(r"\\?\{}", canonical.display());
        let select_arg = format!("/select,{unc_path}");

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
        Err("Downloaded file location was not found.".to_string())
    }
}

#[tauri::command]
fn delete_downloaded_file(path: String) -> Result<bool, String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Ok(false);
    }
    if !target.is_file() {
        return Err("Refusing to delete a folder from the single-file delete action.".to_string());
    }

    std::fs::remove_file(&target)
        .map(|_| true)
        .map_err(|error| format!("Could not delete downloaded file: {error}"))
}

#[tauri::command]
fn scan_downloaded_file(path: String) -> Result<(), String> {
    let target = validate_file_path(&path)?;
    if !target.exists() {
        return Err("Downloaded file was not found.".to_string());
    }
    if !target.is_file() {
        return Err("The selected download path is not a file.".to_string());
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
            "Start-MpScan -ScanType CustomScan -ScanPath $args[0]",
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
        _ => return Err("Unsupported browser.".to_string()),
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
        return Err("Only web links can be opened.".to_string());
    }
    let mut launcher = Command::new("explorer.exe");
    hide_command_window(&mut launcher);
    launcher
        .arg(&url)
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
        return Err("Host is required.".to_string());
    }
    let address = format!("{}:{}", host.trim(), port);
    let mut resolved = address
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve endpoint: {error}"))?;
    let Some(socket_addr) = resolved.next() else {
        return Ok(false);
    };
    // Prevent SSRF: reject connections to loopback, private, link-local, and multicast IPs
    let ip = socket_addr.ip();
    let is_internal = match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_multicast()
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.is_multicast()
        }
    };
    if is_internal {
        return Err("Connections to internal/local addresses are not allowed".to_string());
    }
    Ok(TcpStream::connect_timeout(&socket_addr, Duration::from_millis(1200)).is_ok())
}

#[tauri::command]
fn validate_source_address(address: String) -> Result<bool, String> {
    let parsed: IpAddr = address
        .trim()
        .parse()
        .map_err(|_| "Enter a valid IP address for the VPN adapter.".to_string())?;

    #[cfg(windows)]
    {
        let script =
            "if (Get-NetIPAddress -IPAddress $args[0] -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }";
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
        let script = r#"
$pattern = 'VPN|WireGuard|Wintun|TAP|TUN|OpenVPN|Nord|Proton|Mullvad|Surfshark|Cisco|AnyConnect|Fortinet|GlobalProtect|ZeroTier|Tailscale|WAN Miniport|IKEv2|L2TP|PPTP'
$adapter = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and ($_.Name -match $pattern -or $_.InterfaceDescription -match $pattern)
} | Select-Object -First 1
if ($adapter) { 'yes' } else { 'no' }
"#;
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
    serde_json::from_str::<serde_json::Value>(&settings)
        .map_err(|e| format!("Invalid JSON config: {}", e))?;
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    let config_path = data_dir.join("config.json");
    std::fs::write(&config_path, &settings).map_err(|e| format!("Failed to save config: {}", e))
}

#[tauri::command]
fn restart_daemon(
    app: tauri::AppHandle,
    daemon_url: tauri::State<DaemonUrl>,
) -> Result<(), String> {
    log::info!("NOVA daemon restart requested");
    let our_pid = std::process::id();
    let preferred = requested_daemon_port();
    kill_old_daemon_range(our_pid, preferred);
    std::thread::sleep(std::time::Duration::from_millis(600));
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

/// Kill any orphaned process listening on any daemon port (skips our own PID).
/// Non-blocking: spawns a background thread.
fn kill_old_daemon() {
    let our_pid = std::process::id();
    let preferred = requested_daemon_port();
    std::thread::spawn(move || kill_old_daemon_range(our_pid, preferred));
}

/// Blocking: kills processes on a range of ports.
fn kill_old_daemon_range(our_pid: u32, preferred: u16) {
    for port in preferred..=preferred + DAEMON_PORT_SCAN_LIMIT {
        let script = format!(
            "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object {{ \
                $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; \
                if ($p -and $p.Id -ne {our_pid}) {{ taskkill /F /PID $p.Id -ErrorAction SilentlyContinue }} \
            }}",
        );
        let mut command = Command::new("powershell");
        hide_command_window(&mut command);
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok();
    }
}

pub fn is_integration_mode() -> bool {
    std::env::args().any(|arg| arg == "--integration" || arg == "--background")
}

pub fn run_integration_mode() {
    let preferred_port = std::env::var("NOVA_DAEMON_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|&p| p >= 1024)
        .unwrap_or(3199u16);

    let port = {
        let mut p = preferred_port;
        for _ in 0..30u16 {
            if TcpListener::bind(("127.0.0.1", p)).is_ok() {
                break;
            }
            p = p.saturating_add(1);
        }
        p
    };

    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string();

    let data_dir = {
        let home = std::env::var("APPDATA")
            .or_else(|_| std::env::var("USERPROFILE"))
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        format!("{}/nova-download-manager", home)
    };

    log::info!(
        "Integration mode: starting daemon on port {} (no GUI)",
        port
    );
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
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            kill_old_daemon();
            let default_port = requested_daemon_port();
            let deadline = std::time::Instant::now() + Duration::from_millis(2000);
            loop {
                if is_loopback_port_available(default_port) {
                    break;
                }
                if std::time::Instant::now() > deadline {
                    log::warn!(
                        "Daemon port {} still not available after 2s; starting anyway",
                        default_port
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
                        let pid = std::process::id();
                        let pref = requested_daemon_port();
                        kill_old_daemon_range(pid, pref);
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
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_daemon_url,
            get_daemon_token,
            get_downloads_dir,
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
            restart_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
