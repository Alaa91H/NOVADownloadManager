// The runtime engine-capability snapshot builds a large `serde_json::json!`
// object literal (see daemon::engine_capabilities), which expands past the
// default macro recursion limit of 128.
#![recursion_limit = "512"]

use serde::Serialize;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
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
const DAEMON_GRACEFUL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const DAEMON_GRACEFUL_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(50);
const TAURI_CONFIG_JSON: &str = include_str!("../tauri.conf.json");
const MAX_CONFIG_SIZE: usize = 1024 * 1024;
const SECURE_CONFIG_VALUE: &str = "__nova_secure_store_v1__";
const SECURE_SETTINGS_SERVICE: &str = "com.nova-download-manager.settings";
const SENSITIVE_CONFIG_FIELDS: [(&str, &str); 4] = [
    ("connection", "proxyUser"),
    ("connection", "proxyPass"),
    ("extra", "tgBotToken"),
    ("extra", "browserPairingToken"),
];

// Platform credential stores can reject simultaneous operations on the same
// entry, particularly on Windows and Linux. Serialize all settings-secret I/O.
static SECURE_SETTINGS_LOCK: Mutex<()> = Mutex::new(());
// `write_config_atomically` uses a deterministic temporary filename, so all
// config reads, migrations, and writes must share one in-process transaction.
static CONFIG_IO_LOCK: Mutex<()> = Mutex::new(());

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

fn browser_extension_launch_target(browser: &str) -> Result<(&'static str, &'static str), String> {
    match browser {
        "chrome" => Ok(("chrome.exe", "chrome://extensions")),
        "edge" => Ok(("msedge.exe", "edge://extensions")),
        "firefox" => Ok(("firefox.exe", "about:debugging#/runtime/this-firefox")),
        _ => Err("Unsupported browser.".to_owned()),
    }
}

#[tauri::command]
fn open_browser_extensions(browser: String) -> Result<(), String> {
    let (command, url) = browser_extension_launch_target(&browser)?;

    // Launch the browser process directly.  Routing this through `cmd /C start`
    // can briefly surface a console window on Windows even with CREATE_NO_WINDOW
    // set, which is both distracting and unnecessary for an internal browser URL.
    let mut launcher = Command::new(command);
    hide_command_window(&mut launcher);
    launcher
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open browser extensions page: {error}"))
}

/// Ensure that a browser-launch target cannot resolve to the local network.
///
/// The frontend can pass a task's source URL to this command. Checking only a
/// literal IP address is insufficient because a hostname may resolve to a
/// loopback or private address. Resolve every address first and reject the
/// whole target if any answer is not safe to hand to the system browser.
fn ensure_external_browser_addresses(addresses: &[SocketAddr]) -> Result<(), String> {
    if addresses.is_empty() {
        return Err("The link host did not resolve to an address.".to_owned());
    }

    if addresses
        .iter()
        .any(|address| crate::daemon::utils::is_internal_ip(address.ip()))
    {
        return Err("Internal URLs cannot be opened in the browser.".to_owned());
    }

    Ok(())
}

fn resolve_external_browser_host(host: String, port: u16) -> Result<(), String> {
    let socket_target = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let (sender, receiver) = std::sync::mpsc::channel();

    std::thread::Builder::new()
        .name("nova-external-url-dns".to_owned())
        .spawn(move || {
            let result = socket_target
                .to_socket_addrs()
                .map(|addresses| addresses.collect::<Vec<_>>())
                .map_err(|error| format!("Could not resolve link host: {error}"));
            let _ = sender.send(result);
        })
        .map_err(|error| format!("Could not start link-host validation: {error}"))?;

    let addresses = receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Could not resolve link host: timeout".to_owned())??;
    ensure_external_browser_addresses(&addresses)
}

fn validated_external_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Only web links can be opened.".to_owned());
    }

    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "A link host is required.".to_owned())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "A link port is required.".to_owned())?;

    resolve_external_browser_host(host.to_owned(), port)?;
    // Re-serialize through reqwest::Url to strip embedded shell metacharacters.
    Ok(parsed.into())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let clean_url = validated_external_url(&url)?;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedConfig {
    settings: Option<String>,
    warnings: Vec<String>,
}

fn config_value_mut<'a>(
    settings: &'a mut serde_json::Value,
    section: &str,
    field: &str,
) -> Option<&'a mut serde_json::Value> {
    settings.get_mut(section)?.get_mut(field)
}

fn secure_setting_entry(section: &str, field: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECURE_SETTINGS_SERVICE, &format!("{section}.{field}"))
        .map_err(|error| format!("Failed to access secure credential entry: {error}"))
}

fn read_secure_setting(section: &str, field: &str) -> Result<Option<String>, String> {
    match secure_setting_entry(section, field)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Failed to read secure credential: {error}")),
    }
}

fn delete_secure_setting(section: &str, field: &str) -> Result<(), String> {
    match secure_setting_entry(section, field)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Failed to remove secure credential: {error}")),
    }
}

#[derive(Debug)]
struct SecureSettingMutation {
    section: String,
    field: String,
    previous: Option<String>,
}

fn rollback_secure_setting_mutations(mutations: &[SecureSettingMutation]) {
    for mutation in mutations.iter().rev() {
        let result = match &mutation.previous {
            Some(previous) => {
                secure_setting_entry(&mutation.section, &mutation.field).and_then(|entry| {
                    entry.set_password(previous).map_err(|error| {
                        format!("Failed to restore secure credential during rollback: {error}")
                    })
                })
            }
            None => delete_secure_setting(&mutation.section, &mutation.field),
        };
        if let Err(error) = result {
            log::error!(
                "Failed to roll back secure credential {}.{}: {error}",
                mutation.section,
                mutation.field
            );
        }
    }
}

fn is_secure_settings_enabled(settings: &serde_json::Value) -> bool {
    settings
        .pointer("/extra/encryptAccessTokens")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

fn protect_sensitive_config_fields(
    settings: &mut serde_json::Value,
) -> Result<Vec<SecureSettingMutation>, String> {
    if !is_secure_settings_enabled(settings) {
        return Ok(Vec::new());
    }

    let mut mutations = Vec::new();
    for (section, field) in SENSITIVE_CONFIG_FIELDS {
        let Some(secret) = config_value_mut(settings, section, field)
            .and_then(|value| value.as_str().map(str::to_owned))
        else {
            continue;
        };
        if secret == SECURE_CONFIG_VALUE {
            continue;
        }
        if secret.starts_with("enc:") {
            rollback_secure_setting_mutations(&mutations);
            return Err(
                "A legacy session-encrypted credential cannot be saved. Re-enter the credential before saving."
                    .to_owned(),
            );
        }

        let previous = match read_secure_setting(section, field) {
            Ok(previous) => previous,
            Err(error) => {
                rollback_secure_setting_mutations(&mutations);
                return Err(error);
            }
        };
        if previous.as_deref() != Some(secret.as_str()) {
            let update_result = if secret.is_empty() {
                delete_secure_setting(section, field)
            } else {
                secure_setting_entry(section, field).and_then(|entry| {
                    entry.set_password(&secret).map_err(|error| {
                        format!("Failed to save credential in secure storage: {error}")
                    })
                })
            };
            if let Err(error) = update_result {
                rollback_secure_setting_mutations(&mutations);
                return Err(error);
            }
            mutations.push(SecureSettingMutation {
                section: section.to_owned(),
                field: field.to_owned(),
                previous,
            });
        }
        *config_value_mut(settings, section, field).expect("field remains present") =
            serde_json::Value::String(if secret.is_empty() {
                String::new()
            } else {
                SECURE_CONFIG_VALUE.to_owned()
            });
    }
    Ok(mutations)
}

fn clear_secure_config_fields() {
    let Ok(_lock) = SECURE_SETTINGS_LOCK.lock() else {
        log::warn!("Secure credential storage lock is unavailable while clearing credentials");
        return;
    };
    for (section, field) in SENSITIVE_CONFIG_FIELDS {
        if let Err(error) = delete_secure_setting(section, field) {
            log::warn!("Failed to clear secure credential {section}.{field}: {error}");
        }
    }
}

fn hydrate_secure_config_fields(
    persisted: &mut serde_json::Value,
) -> Result<(serde_json::Value, Vec<String>, bool), String> {
    let mut runtime = persisted.clone();
    if !is_secure_settings_enabled(persisted) {
        return Ok((runtime, Vec::new(), false));
    }

    let _lock = SECURE_SETTINGS_LOCK
        .lock()
        .map_err(|_| "Secure credential storage lock is unavailable".to_owned())?;
    let mut warnings = Vec::new();
    let mut needs_rewrite = false;
    for (section, field) in SENSITIVE_CONFIG_FIELDS {
        let stored = config_value_mut(persisted, section, field)
            .and_then(|value| value.as_str().map(str::to_owned));
        let Some(stored) = stored else {
            continue;
        };
        let Some(runtime_value) = config_value_mut(&mut runtime, section, field) else {
            continue;
        };

        if stored == SECURE_CONFIG_VALUE {
            match secure_setting_entry(section, field)?.get_password() {
                Ok(secret) => *runtime_value = serde_json::Value::String(secret),
                Err(keyring::Error::NoEntry) => {
                    *config_value_mut(persisted, section, field).expect("field remains present") =
                        serde_json::Value::String(String::new());
                    *runtime_value = serde_json::Value::String(String::new());
                    warnings.push(format!(
                        "The secure credential {section}.{field} was unavailable and has been cleared."
                    ));
                    needs_rewrite = true;
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to load credential from secure storage: {error}"
                    ));
                }
            }
        } else if stored.starts_with("enc:") {
            *config_value_mut(persisted, section, field).expect("field remains present") =
                serde_json::Value::String(String::new());
            *runtime_value = serde_json::Value::String(String::new());
            warnings.push(format!(
                "A legacy session-encrypted credential ({section}.{field}) could not be recovered and was cleared."
            ));
            needs_rewrite = true;
        } else if !stored.is_empty() {
            secure_setting_entry(section, field)?
                .set_password(&stored)
                .map_err(|error| {
                    format!("Failed to migrate credential to secure storage: {error}")
                })?;
            *config_value_mut(persisted, section, field).expect("field remains present") =
                serde_json::Value::String(SECURE_CONFIG_VALUE.to_owned());
            needs_rewrite = true;
        }
    }
    Ok((runtime, warnings, needs_rewrite))
}

fn read_config_from_disk(data_dir: &Path) -> Result<Option<serde_json::Value>, String> {
    let config_path = data_dir.join("config.json");
    let backup_path = data_dir.join("config.json.bak");
    let bytes = match std::fs::read(&config_path) {
        Ok(bytes) => bytes,
        // Windows replacement first moves the old file to a short-lived backup.
        // Recover it if the application was interrupted before the new file was
        // promoted, rather than silently presenting a fresh configuration.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read(&backup_path) {
                Ok(bytes) => bytes,
                Err(backup_error) if backup_error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(None)
                }
                Err(backup_error) => {
                    return Err(format!("Failed to read config backup: {backup_error}"))
                }
            }
        }
        Err(error) => return Err(format!("Failed to read config: {error}")),
    };
    if bytes.len() > MAX_CONFIG_SIZE {
        return Err(format!(
            "Config size ({} bytes) exceeds limit ({} bytes)",
            bytes.len(),
            MAX_CONFIG_SIZE
        ));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("Invalid JSON config: {error}"))?;
    if !parsed.is_object() {
        return Err("Config must be a JSON object".to_owned());
    }
    Ok(Some(parsed))
}

fn write_config_atomically(data_dir: &Path, settings: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create app data dir: {e}"))?;
    let config_path = data_dir.join("config.json");
    let tmp_path = data_dir.join("config.json.tmp");
    std::fs::write(&tmp_path, settings).map_err(|e| format!("Failed to save config: {e}"))?;

    let sync_result = std::fs::File::open(&tmp_path)
        .map_err(|e| format!("Failed to reopen temporary config: {e}"))
        .and_then(|file| {
            file.sync_all()
                .map_err(|e| format!("Failed to sync temporary config: {e}"))
        });
    if let Err(error) = sync_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(error);
    }

    // On Unix, rename replaces an existing destination atomically. Windows
    // rejects that form of rename when `config.json` already exists, which made
    // every later settings save fail after the initial successful write. Move
    // the previous file aside first on Windows, restore it if promotion fails,
    // and remove the short-lived backup after a successful replacement.
    #[cfg(windows)]
    {
        let backup_path = data_dir.join("config.json.bak");
        let had_existing_config = config_path.exists();
        let _ = std::fs::remove_file(&backup_path);
        if had_existing_config {
            std::fs::rename(&config_path, &backup_path)
                .map_err(|error| format!("Failed to prepare config replacement: {error}"))?;
        }
        if let Err(error) = std::fs::rename(&tmp_path, &config_path) {
            if had_existing_config {
                let _ = std::fs::rename(&backup_path, &config_path);
            }
            let _ = std::fs::remove_file(&tmp_path);
            return Err(format!("Failed to replace config: {error}"));
        }
        let _ = std::fs::remove_file(&backup_path);
    }

    #[cfg(not(windows))]
    if let Err(error) = std::fs::rename(&tmp_path, &config_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("Failed to atomically replace config: {error}"));
    }
    if let Some(parent) = config_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[tauri::command]
fn save_config(app: tauri::AppHandle, settings: String) -> Result<(), String> {
    if settings.len() > MAX_CONFIG_SIZE {
        return Err(format!(
            "Config size ({} bytes) exceeds limit ({} bytes)",
            settings.len(),
            MAX_CONFIG_SIZE
        ));
    }
    let mut parsed: serde_json::Value =
        serde_json::from_str(&settings).map_err(|error| format!("Invalid JSON config: {error}"))?;
    if !parsed.is_object() {
        return Err("Config must be a JSON object".to_owned());
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let _config_lock = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "Config storage lock is unavailable".to_owned())?;
    let use_secure_storage = is_secure_settings_enabled(&parsed);
    if use_secure_storage {
        let _secure_lock = SECURE_SETTINGS_LOCK
            .lock()
            .map_err(|_| "Secure credential storage lock is unavailable".to_owned())?;
        let mutations = protect_sensitive_config_fields(&mut parsed)?;
        let serialized = serde_json::to_string(&parsed)
            .map_err(|error| format!("Failed to serialize config: {error}"))?;
        if let Err(error) = write_config_atomically(&data_dir, &serialized) {
            rollback_secure_setting_mutations(&mutations);
            return Err(error);
        }
    } else {
        let serialized = serde_json::to_string(&parsed)
            .map_err(|error| format!("Failed to serialize config: {error}"))?;
        write_config_atomically(&data_dir, &serialized)?;
    }
    if !use_secure_storage {
        // The user explicitly opted out of encryption; leave the plaintext config
        // authoritative and remove stale OS-keystore copies without converting a
        // successful config write into a false failure if deletion is unavailable.
        clear_secure_config_fields();
    }
    Ok(())
}

#[tauri::command]
fn load_config(app: tauri::AppHandle) -> Result<LoadedConfig, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data dir: {error}"))?;
    let _config_lock = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "Config storage lock is unavailable".to_owned())?;
    let Some(mut persisted) = read_config_from_disk(&data_dir)? else {
        return Ok(LoadedConfig {
            settings: None,
            warnings: Vec::new(),
        });
    };
    let (runtime, warnings, needs_rewrite) = hydrate_secure_config_fields(&mut persisted)?;
    if needs_rewrite {
        let serialized = serde_json::to_string(&persisted)
            .map_err(|error| format!("Failed to serialize migrated config: {error}"))?;
        write_config_atomically(&data_dir, &serialized)?;
    }
    let settings = serde_json::to_string(&runtime)
        .map_err(|error| format!("Failed to serialize loaded config: {error}"))?;
    Ok(LoadedConfig {
        settings: Some(settings),
        warnings,
    })
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
    let data_dir_path = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    // Signal the running daemon to shut down gracefully. It saves paused state
    // and removes its port file after the listener has stopped. Do not hard-kill
    // it while that flush is still in progress.
    crate::daemon::signal_shutdown();
    let stopped_cleanly =
        wait_for_daemon_port_file_removal(&data_dir_path, DAEMON_GRACEFUL_SHUTDOWN_TIMEOUT);
    if !stopped_cleanly {
        // M-3: kill only the recorded daemon PID (read from the port file) instead
        // of spawning a PowerShell process for every port in the scan range, which
        // froze the UI for seconds. Fall back to the range scan only when no PID
        // is on file.
        log::warn!("Daemon did not stop cleanly before restart timeout; forcing shutdown");
        let our_pid = std::process::id();
        let preferred = requested_daemon_port();
        if !kill_pid_from_port_file(&data_dir_path, our_pid) {
            kill_old_daemon_range(our_pid, preferred);
        }
    }
    let port = find_available_daemon_port(requested_daemon_port());
    set_daemon_url(&daemon_url, port);
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .display()
        .to_string();
    daemon::start_daemon(resource_dir, data_dir_path.display().to_string(), port);
    Ok(())
}

fn daemon_port_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join("nova-daemon.port")
}

/// Wait for a graceful daemon shutdown to remove its discovery marker. A stale
/// marker after the bounded wait means the caller may escalate to a hard kill.
fn wait_for_daemon_port_file_removal(data_dir: &Path, timeout: Duration) -> bool {
    let port_file = daemon_port_file_path(data_dir);
    let deadline = std::time::Instant::now() + timeout;
    while port_file.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(DAEMON_GRACEFUL_SHUTDOWN_POLL_INTERVAL);
    }
    !port_file.exists()
}

/// Read the daemon PID from the second line of the current port-file format.
/// The first line is the loopback port; an absent or malformed PID is not trusted.
fn parse_daemon_pid_from_port_file(content: &str) -> Option<u32> {
    content
        .lines()
        .nth(1)
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .and_then(|line| line.parse::<u32>().ok())
        .filter(|pid| *pid != 0)
}

fn legacy_daemon_data_dir() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(|base| PathBuf::from(base).join("nova-download-manager"))
}

/// Read the daemon PID recorded in the actual Tauri app-data port file and
/// kill it. Legacy integration-mode storage is consulted only as a fallback.
/// Returns true when a PID was found (and killed); false means the caller
/// should fall back to scanning the port range.
fn kill_pid_from_port_file(data_dir: &Path, our_pid: u32) -> bool {
    let mut data_dirs = vec![data_dir.to_path_buf()];
    if let Some(legacy_dir) = legacy_daemon_data_dir() {
        if !data_dirs.iter().any(|candidate| candidate == &legacy_dir) {
            data_dirs.push(legacy_dir);
        }
    }

    for port_file in data_dirs
        .into_iter()
        .map(|candidate| daemon_port_file_path(&candidate))
    {
        if let Ok(content) = std::fs::read_to_string(&port_file) {
            if let Some(old_pid) = parse_daemon_pid_from_port_file(&content) {
                if old_pid != our_pid {
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
fn kill_old_daemon(data_dir: PathBuf) {
    let our_pid = std::process::id();
    let preferred = requested_daemon_port();
    std::thread::spawn(move || {
        if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // Prefer the recorded PID; fall back to scanning the port range.
            if !kill_pid_from_port_file(&data_dir, our_pid) {
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

fn is_integration_argument(argument: &str) -> bool {
    argument == "--integration"
}

#[must_use]
pub fn is_integration_mode() -> bool {
    std::env::args().any(|argument| is_integration_argument(&argument))
}

fn default_integration_data_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "nova-download-manager-integration-{}",
        std::process::id()
    ))
}

fn integration_data_dir() -> PathBuf {
    std::env::var_os("NOVA_INTEGRATION_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_integration_data_dir)
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

    // Integration must never reuse a real user's persistent downloads state.
    // Callers can provide a dedicated temporary directory; otherwise scope one
    // to this process below the OS temporary directory.
    let data_dir = integration_data_dir();

    log::info!(
        "Integration mode: starting isolated daemon on port {port} with data at {} (no GUI)",
        data_dir.display()
    );
    daemon::start_daemon(resource_dir, data_dir.display().to_string(), port);

    // Keep the test host alive only while its daemon thread is running. A
    // graceful SIGTERM stops the server, removes its port file, then lets this
    // process exit instead of leaving a background integration process behind.
    while daemon::is_running() {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    log::info!("Integration daemon stopped; exiting host process.");
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
            let daemon_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            kill_old_daemon(daemon_data_dir.clone());
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
            daemon::start_daemon(
                resource_dir,
                daemon_data_dir.display().to_string(),
                startup_port,
            );

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
            load_config,
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
    fn browser_extension_pages_launch_the_browser_directly_without_cmd() {
        assert_eq!(
            browser_extension_launch_target("chrome").expect("chrome launch target"),
            ("chrome.exe", "chrome://extensions")
        );
        assert_eq!(
            browser_extension_launch_target("edge").expect("edge launch target"),
            ("msedge.exe", "edge://extensions")
        );
        assert_eq!(
            browser_extension_launch_target("firefox").expect("firefox launch target"),
            ("firefox.exe", "about:debugging#/runtime/this-firefox")
        );
        assert!(browser_extension_launch_target("unknown").is_err());
    }

    #[test]
    fn integration_mode_requires_the_explicit_test_flag() {
        assert!(is_integration_argument("--integration"));
        assert!(!is_integration_argument("--background"));
        assert!(!is_integration_argument("--integration=true"));
    }

    #[test]
    fn default_integration_data_dir_is_temp_scoped_per_process() {
        let data_dir = default_integration_data_dir();
        assert!(data_dir.starts_with(std::env::temp_dir()));
        assert_eq!(
            data_dir.file_name().and_then(|name| name.to_str()),
            Some(format!("nova-download-manager-integration-{}", std::process::id()).as_str())
        );
    }

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
    fn parses_daemon_pid_from_current_port_file_format() {
        assert_eq!(
            parse_daemon_pid_from_port_file("3199\n12345\n"),
            Some(12345)
        );
        assert_eq!(parse_daemon_pid_from_port_file("3199\n"), None);
        assert_eq!(parse_daemon_pid_from_port_file("3199\n0\n"), None);
        assert_eq!(parse_daemon_pid_from_port_file("3199\ninvalid\n"), None);
    }

    #[test]
    fn daemon_shutdown_is_complete_when_app_data_has_no_port_file() {
        let data_dir = std::env::temp_dir().join(format!(
            "nova-daemon-shutdown-test-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(wait_for_daemon_port_file_removal(
            &data_dir,
            Duration::from_millis(0)
        ));
    }

    #[test]
    fn config_reader_recovers_the_replacement_backup_when_primary_is_missing() {
        let data_dir =
            std::env::temp_dir().join(format!("nova-config-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create config directory");
        std::fs::write(
            data_dir.join("config.json.bak"),
            r#"{"version":2,"theme":"light"}"#,
        )
        .expect("write backup config");

        let loaded = read_config_from_disk(&data_dir)
            .expect("read backup config")
            .expect("backup config is present");
        assert_eq!(loaded["version"], serde_json::json!(2));
        assert_eq!(loaded["theme"], serde_json::json!("light"));
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn atomic_config_writer_replaces_existing_config_without_temp_leftover() {
        let data_dir =
            std::env::temp_dir().join(format!("nova-config-writer-test-{}", uuid::Uuid::new_v4()));
        let initial = r#"{"version":1,"theme":"dark"}"#;
        let replacement = r#"{"version":2,"theme":"light"}"#;

        write_config_atomically(&data_dir, initial).expect("write initial config");
        write_config_atomically(&data_dir, replacement).expect("replace config");

        assert_eq!(
            std::fs::read_to_string(data_dir.join("config.json")).expect("read config"),
            replacement
        );
        assert!(!data_dir.join("config.json.tmp").exists());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn legacy_session_encrypted_credentials_are_cleared_with_a_warning() {
        let mut persisted = serde_json::json!({
            "connection": {
                "proxyUser": "",
                "proxyPass": ""
            },
            "extra": {
                "encryptAccessTokens": true,
                "tgBotToken": "enc:legacy-session-ciphertext"
            }
        });

        let (runtime, warnings, needs_rewrite) =
            hydrate_secure_config_fields(&mut persisted).expect("migrate legacy config");

        assert!(needs_rewrite);
        assert_eq!(persisted["extra"]["tgBotToken"], "");
        assert_eq!(runtime["extra"]["tgBotToken"], "");
        assert!(warnings
            .iter()
            .any(|warning| warning.contains("legacy session-encrypted credential")));
    }

    #[test]
    fn updater_status_rejects_repository_placeholder_configuration() {
        let status = get_updater_configuration_status();

        assert!(!status.configured);
        assert!(status
            .message
            .is_some_and(|message| message.contains("not configured")));
    }

    #[test]
    fn browser_launch_address_guard_rejects_loopback_and_private_ips() {
        let addresses = [
            "127.0.0.1:443".parse().expect("parse loopback address"),
            "192.168.1.5:443".parse().expect("parse private address"),
        ];

        let error = ensure_external_browser_addresses(&addresses).expect_err("reject internal IPs");

        assert!(error.contains("Internal URLs"));
    }

    #[test]
    fn browser_launch_address_guard_accepts_public_ip() {
        let addresses = ["1.1.1.1:443".parse().expect("parse public address")];

        assert!(ensure_external_browser_addresses(&addresses).is_ok());
    }

    #[test]
    fn browser_launch_url_guard_rejects_non_web_schemes_before_dns() {
        let error =
            validated_external_url("file:///C:/Windows/System32").expect_err("reject file URL");

        assert!(error.contains("Only web links"));
    }
}
