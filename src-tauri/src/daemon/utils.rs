use base64::Engine;
use crate::daemon::types::Segment;

/// Lock a Mutex and return the guard, or log error and recover on poison.
#[macro_export]
macro_rules! lock_or_err {
    ($mutex:expr, $default:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::error!("Mutex poisoned, recovering: {}", poisoned);
                poisoned.into_inner()
            }
        }
    };
    ($mutex:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::error!("Mutex poisoned, recovering: {}", poisoned);
                poisoned.into_inner()
            }
        }
    };
}

pub fn map_aria_status(s: &str) -> &'static str {
    match s {
        "active" => "downloading",
        "waiting" => "queued",
        "paused" => "paused",
        "error" => "error",
        "complete" => "completed",
        "removed" => "error",
        _ => "queued",
    }
}

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

#[allow(dead_code)]
pub fn is_media_url(url: &str) -> bool {
    regex_like_match(url, &[
        "youtube.com", "youtu.be", "vimeo.com", "tiktok.com",
        "soundcloud.com", "instagram.com", "x.com", "twitter.com",
    ]) || url.ends_with(".m3u8") || url.contains(".m3u8?")
    || url.ends_with(".mpd") || url.contains(".mpd?")
}

#[allow(dead_code)]
pub fn regex_like_match(url: &str, domains: &[&str]) -> bool {
    let lower = url.to_lowercase();
    domains.iter().any(|d| lower.contains(d))
}

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

pub fn now_str() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

pub fn base64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(windows)]
pub fn kill_process(pid: u32) {
    let _ = std::process::Command::new("taskkill")
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
