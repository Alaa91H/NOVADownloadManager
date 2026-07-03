use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

mod daemon;

struct DaemonUrl(Mutex<String>);

#[derive(Serialize)]
struct BrowserExtensionPaths {
    dev_path: String,
    resource_path: String,
}

#[cfg(windows)]
fn hide_command_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_command_window(_command: &mut Command) {}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_daemon_url(state: tauri::State<DaemonUrl>) -> String {
    state.0.lock().map(|g| g.clone()).unwrap_or_else(|_| "http://127.0.0.1:3199".to_string())
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
        .unwrap_or_else(|_| PathBuf::from(r"C:\Program Files\Nova Download Manager\resources"))
        .join("browser-extension");

    BrowserExtensionPaths {
        dev_path: dev_path.display().to_string(),
        resource_path: resource_path.display().to_string(),
    }
}

#[tauri::command]
fn open_extension_folder(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("Extension folder was not found.".to_string());
    }
    open_with_explorer(&target)
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
fn restart_daemon() -> Result<(), String> {
    log::info!("NOVA daemon restart requested (in-process daemon runs for app lifetime)");
    Ok(())
}

/// Kill any orphaned process listening on the daemon port (skips our own PID).
fn kill_old_daemon() {
    let port = std::env::var("NOVA_DAEMON_PORT").unwrap_or_else(|_| "3199".to_string());
    let our_pid = std::process::id();
    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    let findstr = format!(":{} ", port);
    let output = command
        .args([
            "/c",
            &format!("for /f \"tokens=5\" %p in ('netstat -ano ^| findstr \"{}\" ^| findstr LISTENING') do if not %p=={} taskkill /f /pid %p 2>nul", findstr, our_pid),
        ])
        .output();
    if let Ok(out) = output {
        if !out.stdout.is_empty() || !out.stderr.is_empty() {
            log::info!("Cleaned up orphaned process on daemon port");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            let default_port: u16 = std::env::var("NOVA_DAEMON_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3199);
            let default_url = format!("http://127.0.0.1:{}", default_port);
            app.manage(DaemonUrl(Mutex::new(default_url.clone())));

            // Kill any orphaned process from previous sessions on the daemon port
            kill_old_daemon();
            std::thread::sleep(Duration::from_millis(2000));

            // Start the Rust daemon (spawns its own background thread)
            let resource_dir = app.path()
                .resource_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .display()
                .to_string();
            let data_dir = app.path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .display()
                .to_string();
            daemon::start_daemon(resource_dir, data_dir, default_port);

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
                        kill_old_daemon();
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
            get_downloads_dir,
            get_browser_extension_paths,
            open_extension_folder,
            open_browser_extensions,
            open_external_url,
            restart_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
