// NOVA native runtime: daemon + browser Native Messaging host.
// The desktop presentation layer is Qt/QML under desktop-native/.
#![recursion_limit = "512"]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub mod daemon;
pub mod logging;
pub mod native_host;

pub use native_host::{is_native_messaging_launch, run_native_messaging_host};

const DEFAULT_DAEMON_PORT: u16 = 3199;
const DAEMON_PORT_SCAN_LIMIT: u16 = 30;
const MAX_CONFIG_SIZE: usize = 1024 * 1024;

pub(crate) static CONFIG_IO_LOCK: Mutex<()> = Mutex::new(());

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

    match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)) {
        Ok(listener) => listener
            .local_addr()
            .ok()
            .map(|address| address.port())
            .filter(|port| *port != 0)
            .unwrap_or(preferred_port),
        Err(error) => {
            log::warn!(
                "Could not allocate an OS-assigned loopback port after {preferred_port} was unavailable: {error}"
            );
            preferred_port
        }
    }
}

fn requested_daemon_port() -> u16 {
    std::env::var("NOVA_DAEMON_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port >= 1024)
        .unwrap_or(DEFAULT_DAEMON_PORT)
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

/// Persistent data directory shared by the Qt frontend, headless daemon and
/// Native Messaging host. Keep the historical application ID so upgrading
/// from the former desktop shell does not fork user state.
#[must_use]
pub fn native_desktop_data_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("NOVA_NATIVE_DATA_DIR")
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(override_dir);
    }

    #[cfg(target_os = "windows")]
    if let Some(base) = std::env::var_os("APPDATA").filter(|value| !value.is_empty()) {
        return PathBuf::from(base).join("com.nova.downloadmanager");
    }

    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("com.nova.downloadmanager");
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME")
            .filter(|value| !value.is_empty())
        {
            return PathBuf::from(xdg).join("com.nova.downloadmanager");
        }
        if let Some(home) = std::env::var_os("HOME").filter(|value| !value.is_empty()) {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("com.nova.downloadmanager");
        }
    }

    std::env::temp_dir().join("com.nova.downloadmanager")
}

pub(crate) fn read_config_from_disk(
    data_dir: &Path,
) -> Result<Option<serde_json::Value>, String> {
    let config_path = data_dir.join("config.json");
    let backup_path = data_dir.join("config.json.bak");
    let bytes = match std::fs::read(&config_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read(&backup_path) {
                Ok(bytes) => bytes,
                Err(backup_error)
                    if backup_error.kind() == std::io::ErrorKind::NotFound =>
                {
                    return Ok(None);
                }
                Err(backup_error) => {
                    return Err(format!("Failed to read config backup: {backup_error}"));
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

pub(crate) fn write_config_atomically(
    data_dir: &Path,
    settings: &str,
) -> Result<(), String> {
    if settings.len() > MAX_CONFIG_SIZE {
        return Err(format!(
            "Config size ({} bytes) exceeds limit ({} bytes)",
            settings.len(),
            MAX_CONFIG_SIZE
        ));
    }

    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("Failed to create app data dir: {error}"))?;

    let config_path = data_dir.join("config.json");
    let tmp_path = data_dir.join("config.json.tmp");
    std::fs::write(&tmp_path, settings)
        .map_err(|error| format!("Failed to save config: {error}"))?;

    std::fs::File::open(&tmp_path)
        .map_err(|error| format!("Failed to reopen temporary config: {error}"))?
        .sync_all()
        .map_err(|error| format!("Failed to sync temporary config: {error}"))?;

    #[cfg(windows)]
    {
        let backup_path = data_dir.join("config.json.bak");
        let had_existing = config_path.exists();
        let _ = std::fs::remove_file(&backup_path);
        if had_existing {
            std::fs::rename(&config_path, &backup_path)
                .map_err(|error| format!("Failed to prepare config replacement: {error}"))?;
        }
        if let Err(error) = std::fs::rename(&tmp_path, &config_path) {
            if had_existing {
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

    if let Some(parent) = config_path.parent().filter(|path| !path.as_os_str().is_empty()) {
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
    }

    Ok(())
}

pub fn run_integration_mode() {
    let port = find_available_daemon_port(requested_daemon_port());
    let resource_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let data_dir = integration_data_dir();

    log::info!(
        "Integration mode: starting isolated NOVA daemon on port {port} with data at {}",
        data_dir.display()
    );
    daemon::start_daemon(
        resource_dir.display().to_string(),
        data_dir.display().to_string(),
        port,
    );

    while daemon::is_running() {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Production headless backend owned by the Qt/QML desktop application.
pub fn run_native_backend() {
    let port = find_available_daemon_port(requested_daemon_port());
    let resource_dir = std::env::var_os("NOVA_RESOURCE_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
        })
        .unwrap_or_else(|| PathBuf::from("."));

    let data_dir = native_desktop_data_dir();
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        log::error!(
            "Native backend could not create app data directory {}: {error}",
            data_dir.display()
        );
        return;
    }

    log::info!(
        "Native backend: starting daemon on port {port} with persistent data at {}",
        data_dir.display()
    );
    daemon::start_daemon(
        resource_dir.display().to_string(),
        data_dir.display().to_string(),
        port,
    );

    while daemon::is_running() {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_mode_requires_explicit_flag() {
        assert!(is_integration_argument("--integration"));
        assert!(!is_integration_argument("--background"));
    }

    #[test]
    fn native_desktop_data_dir_honors_explicit_override() {
        let expected = std::env::temp_dir().join(format!(
            "nova-native-data-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::env::set_var("NOVA_NATIVE_DATA_DIR", &expected);
        assert_eq!(native_desktop_data_dir(), expected);
        std::env::remove_var("NOVA_NATIVE_DATA_DIR");
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
}
