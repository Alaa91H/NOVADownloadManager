use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

struct DaemonHandle(Mutex<Option<Child>>);

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
fn get_daemon_url() -> String {
    std::env::var("VITE_NOVA_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3199".to_string())
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
fn restart_daemon(app: tauri::AppHandle, state: tauri::State<DaemonHandle>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Could not access the daemon process state.".to_string())?;

    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    kill_old_daemon();
    std::thread::sleep(Duration::from_millis(500));
    let child = spawn_daemon(&app).ok_or_else(|| "Could not start the NOVA download service.".to_string())?;
    *guard = Some(child);
    Ok(())
}

/// Kill any process listening on port 3199 before spawning the daemon.
fn kill_old_daemon() {
    let mut command = Command::new("cmd");
    hide_command_window(&mut command);
    let output = command
        .args([
            "/c",
            "for /f \"tokens=5\" %p in ('netstat -ano ^| findstr \":3199 \" ^| findstr LISTENING') do taskkill /f /pid %p 2>nul",
        ])
        .output();
    if let Ok(out) = output {
        if !out.stdout.is_empty() || !out.stderr.is_empty() {
            log::info!("Cleaned up old daemon process");
        }
    }
}

fn spawn_daemon(app: &tauri::AppHandle) -> Option<Child> {
    let resources = app.path().resource_dir().ok();
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = resources.clone().unwrap_or(current_dir);
    let bundled_daemon = cwd.join("nova-daemon.cjs");
    let bundled_node = cwd.join(if cfg!(windows) { "node.exe" } else { "node" });
    let direct_engine = cwd.join("bin").join("aria2c.exe");
    let media_engine = cwd.join("bin").join("yt-dlp.exe");

    let mut command = if bundled_daemon.exists() && bundled_node.exists() {
        let mut cmd = Command::new(bundled_node);
        cmd.arg(bundled_daemon);
        cmd
    } else {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "npx", "tsx", "server/nova-daemon.ts"]);
        cmd
    };

    hide_command_window(&mut command);
    command
        .current_dir(&cwd)
        .env("VITE_APP_VERSION", env!("CARGO_PKG_VERSION"))
        .env("NOVA_DAEMON_PORT", "3199")
        .env("NOVA_ARIA2C", direct_engine)
        .env("NOVA_YTDLP", media_engine)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    match command.spawn() {
        Ok(child) => {
            log::info!("NOVA daemon started from {}", cwd.display());
            Some(child)
        }
        Err(error) => {
            log::error!("Failed to start daemon: {}", error);
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .setup(|app| {
            kill_old_daemon();
            std::thread::sleep(Duration::from_millis(500));
            let app_handle = app.handle().clone();
            app.manage(DaemonHandle(Mutex::new(spawn_daemon(&app_handle))));

            let show = MenuItem::with_id(app, "show", "Show NOVA", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &sep, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("NOVA Download Manager")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "quit" => {
                        if let Some(handle) = app.try_state::<DaemonHandle>() {
                            if let Ok(mut guard) = handle.0.lock() {
                                if let Some(mut c) = guard.take() {
                                    let _ = c.kill();
                                }
                            }
                        }
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
            get_browser_extension_paths,
            open_extension_folder,
            open_browser_extensions,
            restart_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
