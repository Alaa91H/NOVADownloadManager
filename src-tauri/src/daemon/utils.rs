use std::net::{IpAddr, ToSocketAddrs};
use std::process::Command;
use crate::daemon::types::Segment;

/// Browser-like UA avoids 403/Forbidden from CDNs and download mirrors that
/// block non-browser clients (e.g. some anti-hotlink middleware).
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// Lock a Mutex and return the guard, or log error and recover on poison.
#[macro_export]
macro_rules! lock_or_err {
    ($mutex:expr, $default:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::error!("Mutex poisoned ({}:{}), recovering: {}", file!(), line!(), poisoned);
                #[cfg(debug_assertions)]
                log::error!("Backtrace: {}", std::backtrace::Backtrace::force_capture());
                poisoned.into_inner()
            }
        }
    };
    ($mutex:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::error!("Mutex poisoned ({}:{}), recovering: {}", file!(), line!(), poisoned);
                #[cfg(debug_assertions)]
                log::error!("Backtrace: {}", std::backtrace::Backtrace::force_capture());
                poisoned.into_inner()
            }
        }
    };
}

/// Validate that a URL targets an external (non-private) host to prevent SSRF.
/// Rejects empty URLs, non-http(s) schemes, and private/loopback/link-local/multicast IPs.
pub fn is_safe_target_url(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("URL is empty".to_string());
    }
    let url = raw.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http(s) URLs are allowed for network requests".to_string());
    }
    let host = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("");
    if host.is_empty() || host == "localhost" {
        return Err("Host is empty or localhost".to_string());
    }
    fn is_internal_ip(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_multicast(),
            IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.is_multicast(),
        }
    }
    // Try to parse as IP first
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_internal_ip(ip) {
            return Err(format!("SSRF blocked: URL targets internal IP {}", ip));
        }
        return Ok(());
    }
    // Resolve hostname and check all resolved addresses
    let addr_str = format!("{}:443", host);
    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve host '{}': {}", host, e))?;
    for addr in addrs {
        let ip = addr.ip();
        if is_internal_ip(ip) {
            return Err(format!("SSRF blocked: host '{}' resolves to internal IP {}", host, ip));
        }
    }
    Ok(())
}

#[inline]
pub fn infer_file_type(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "iso" | "cab" => "compressed",
        "exe" | "msi" | "apk" | "dmg" | "pkg" | "bat" | "sh" => "program",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "txt" | "epub" => "document",
        "mp4" | "mkv" | "avi" | "mov" | "flv" | "wmv" | "webm" | "ts" => "video",
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "wma" => "audio",
        _ => "other",
    }
}

#[inline]
pub fn build_segments(connections: u32, total: u64, downloaded: u64, _active: bool, speed: u64) -> Vec<Segment> {
    if total == 0 {
        return vec![Segment { id: 0, progress: 0.0, downloaded_bytes: downloaded, total_bytes: 0, active: true, speed }];
    }
    let per_seg = total / connections.max(1) as u64;
    let mut segs = Vec::new();
    for i in 0..connections {
        let seg_start = i as u64 * per_seg;
        let seg_end = if i == connections - 1 { total } else { seg_start + per_seg };
        let seg_done = downloaded.saturating_sub(seg_start).min(seg_end - seg_start);
        segs.push(Segment {
            id: i,
            progress: if seg_end > seg_start { seg_done as f64 / (seg_end - seg_start) as f64 } else { 0.0 },
            downloaded_bytes: seg_done,
            total_bytes: seg_end - seg_start,
            active: true,
            speed: speed / connections.max(1) as u64,
        });
    }
    segs
}

#[inline]
pub fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

/// Split a string into arguments like a POSIX shell, handling double/single quotes.
/// This prevents whitespace splitting from breaking quoted values (e.g. --add-header "X-Custom: a b").
pub fn shell_split(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' => {
                while let Some(&next) = chars.peek() {
                    if next == '\'' {
                        chars.next();
                        break;
                    }
                    current.push(next);
                    chars.next();
                }
            }
            '"' => {
                while let Some(&next) = chars.peek() {
                    if next == '"' {
                        chars.next();
                        break;
                    }
                    if next == '\\' {
                        chars.next();
                        if let Some(escaped) = chars.next() {
                            current.push(escaped);
                        }
                    } else {
                        current.push(next);
                        chars.next();
                    }
                }
            }
            c if c.is_ascii_whitespace() => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

/// Push a flag-value pair onto a CLI argument vector.
#[inline]
pub fn push_arg(args: &mut Vec<String>, flag: &str, value: &str) {
    args.push(flag.to_string());
    args.push(value.to_string());
}

#[inline]
pub fn hide_command_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(windows)]
pub fn kill_process(pid: u32) {
    let mut cmd = std::process::Command::new("taskkill");
    hide_command_window(&mut cmd);
    let _ = cmd
        .args(["/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(not(windows))]
pub fn kill_process(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(&["-9", &pid.to_string()])
        .spawn();
}

#[inline]
pub fn mime_for_path(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
