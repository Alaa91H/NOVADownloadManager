use crate::daemon::types::Segment;
use std::net::{IpAddr, ToSocketAddrs};
use std::process::Command;

/// Browser-like UA avoids 403/Forbidden from CDNs and download mirrors that
/// block non-browser clients (e.g. some anti-hotlink middleware).
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

/// Lock a Mutex and return the guard, or log error and recover on poison.
/// Recovery is safe here because our mutexes protect simple data (HashMaps)
/// and we always prefer availability over correctness after poison.
#[macro_export]
macro_rules! lock_or_err {
    ($mutex:expr, $default:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::warn!(
                    "Mutex poisoned at {}:{}, recovering (previous holder may have panicked): {}",
                    file!(),
                    line!(),
                    poisoned
                );
                #[cfg(debug_assertions)]
                log::debug!(
                    "Poison backtrace: {}",
                    std::backtrace::Backtrace::force_capture()
                );
                poisoned.into_inner()
            }
        }
    };
    ($mutex:expr) => {
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                log::warn!(
                    "Mutex poisoned at {}:{}, recovering (previous holder may have panicked): {}",
                    file!(),
                    line!(),
                    poisoned
                );
                #[cfg(debug_assertions)]
                log::debug!(
                    "Poison backtrace: {}",
                    std::backtrace::Backtrace::force_capture()
                );
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
            IpAddr::V4(v4) => {
                v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_multicast()
            }
            IpAddr::V6(v6) => {
                v6.is_loopback() || (v6.segments()[0] & 0xffc0) == 0xfe80 || v6.is_multicast()
            }
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
            return Err(format!(
                "SSRF blocked: host '{}' resolves to internal IP {}",
                host, ip
            ));
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
pub fn build_segments(
    connections: u32,
    total: u64,
    downloaded: u64,
    _active: bool,
    speed: u64,
) -> Vec<Segment> {
    if total == 0 {
        return vec![Segment {
            id: 0,
            progress: 0.0,
            downloaded_bytes: downloaded,
            total_bytes: 0,
            active: true,
            speed,
        }];
    }
    let per_seg = total / connections.max(1) as u64;
    let mut segs = Vec::new();
    for i in 0..connections {
        let seg_start = i as u64 * per_seg;
        let seg_end = if i == connections - 1 {
            total
        } else {
            seg_start + per_seg
        };
        let seg_done = downloaded
            .saturating_sub(seg_start)
            .min(seg_end - seg_start);
        segs.push(Segment {
            id: i,
            progress: if seg_end > seg_start {
                seg_done as f64 / (seg_end - seg_start) as f64
            } else {
                0.0
            },
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
        .args(["-9", &pid.to_string()])
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_safe_target_url ────────────────────────────────────────────────

    #[test]
    fn empty_url_rejected() {
        assert!(is_safe_target_url("").is_err());
    }

    #[test]
    fn non_http_scheme_rejected() {
        assert!(is_safe_target_url("ftp://example.com/file").is_err());
        assert!(is_safe_target_url("file:///etc/passwd").is_err());
        assert!(is_safe_target_url("magnet:?xt=urn:btih:abc").is_err());
        assert!(is_safe_target_url("data:text/html,<h1>hi</h1>").is_err());
    }

    #[test]
    fn localhost_rejected() {
        assert!(is_safe_target_url("http://localhost/secret").is_err());
        assert!(is_safe_target_url("https://localhost:8080/api").is_err());
    }

    #[test]
    fn private_ip_192_168_rejected() {
        assert!(is_safe_target_url("http://192.168.1.1/admin").is_err());
    }

    #[test]
    fn private_ip_10_rejected() {
        assert!(is_safe_target_url("http://10.0.0.1/admin").is_err());
    }

    #[test]
    fn loopback_127_rejected() {
        assert!(is_safe_target_url("http://127.0.0.1/secret").is_err());
        assert!(is_safe_target_url("http://127.0.0.2/secret").is_err());
    }

    #[test]
    fn link_local_169_254_rejected() {
        assert!(is_safe_target_url("http://169.254.169.254/metadata").is_err());
    }

    #[test]
    fn multicast_rejected() {
        assert!(is_safe_target_url("http://224.0.0.1/mcast").is_err());
        assert!(is_safe_target_url("http://239.255.255.250/mcast").is_err());
    }

    #[test]
    fn ipv6_loopback_rejected() {
        assert!(is_safe_target_url("http://[::1]/secret").is_err());
    }

    #[test]
    fn ipv6_multicast_rejected() {
        assert!(is_safe_target_url("http://[ff02::1]/mcast").is_err());
    }

    #[test]
    fn valid_public_hostname_accepted() {
        assert!(is_safe_target_url("https://example.com").is_ok());
        assert!(is_safe_target_url("https://example.com:443/path").is_ok());
    }

    #[test]
    fn valid_public_ip_accepted() {
        assert!(is_safe_target_url("http://8.8.8.8/dns-query").is_ok());
    }

    #[test]
    fn leading_trailing_whitespace_handled() {
        assert!(is_safe_target_url("  https://example.com  ").is_ok());
    }

    #[test]
    fn empty_host_after_port_rejected() {
        assert!(is_safe_target_url("http://:80/").is_err());
    }

    // ── infer_file_type ───────────────────────────────────────────────────

    #[test]
    fn zip_is_compressed() {
        assert_eq!(infer_file_type("archive.zip"), "compressed");
    }

    #[test]
    fn rar_is_compressed() {
        assert_eq!(infer_file_type("backup.rar"), "compressed");
    }

    #[test]
    fn exe_is_program() {
        assert_eq!(infer_file_type("setup.exe"), "program");
    }

    #[test]
    fn apk_is_program() {
        assert_eq!(infer_file_type("app.apk"), "program");
    }

    #[test]
    fn pdf_is_document() {
        assert_eq!(infer_file_type("report.pdf"), "document");
    }

    #[test]
    fn mp4_is_video() {
        assert_eq!(infer_file_type("clip.mp4"), "video");
    }

    #[test]
    fn mkv_is_video() {
        assert_eq!(infer_file_type("movie.mkv"), "video");
    }

    #[test]
    fn mp3_is_audio() {
        assert_eq!(infer_file_type("song.mp3"), "audio");
    }

    #[test]
    fn flac_is_audio() {
        assert_eq!(infer_file_type("lossless.flac"), "audio");
    }

    #[test]
    fn unknown_extension_is_other() {
        assert_eq!(infer_file_type("file.xyz123"), "other");
    }

    #[test]
    fn no_extension_is_other() {
        assert_eq!(infer_file_type("Makefile"), "other");
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(infer_file_type("ARCHIVE.ZIP"), "compressed");
        assert_eq!(infer_file_type("Setup.EXE"), "program");
        assert_eq!(infer_file_type("Report.PDF"), "document");
        assert_eq!(infer_file_type("CLIP.MP4"), "video");
        assert_eq!(infer_file_type("SONG.MP3"), "audio");
    }

    // ── build_segments ────────────────────────────────────────────────────

    #[test]
    fn four_connections_split_total_evenly() {
        let segs = build_segments(4, 1000, 0, true, 0);
        assert_eq!(segs.len(), 4);
        let total: u64 = segs.iter().map(|s| s.total_bytes).sum();
        assert_eq!(total, 1000);
    }

    #[test]
    fn last_segment_picks_up_remainder() {
        let segs = build_segments(4, 1000, 0, true, 0);
        assert_eq!(segs[3].total_bytes, 250);
    }

    #[test]
    fn single_connection_covers_entire_range() {
        let segs = build_segments(1, 5000, 0, true, 0);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].total_bytes, 5000);
        assert_eq!(segs[0].progress, 0.0);
    }

    #[test]
    fn zero_total_returns_single_segment() {
        let segs = build_segments(4, 0, 0, true, 1024);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].total_bytes, 0);
        assert_eq!(segs[0].downloaded_bytes, 0);
        assert_eq!(segs[0].speed, 1024);
    }

    #[test]
    fn progress_calculated_correctly() {
        let segs = build_segments(2, 1000, 600, true, 200);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].progress, 1.0);
        assert_eq!(segs[0].downloaded_bytes, 500);
        assert!((segs[1].progress - 0.2).abs() < f64::EPSILON);
        assert_eq!(segs[1].downloaded_bytes, 100);
    }

    #[test]
    fn downloaded_beyond_seg_clamps() {
        let segs = build_segments(2, 1000, 9999, true, 0);
        for seg in &segs {
            assert!(seg.downloaded_bytes <= seg.total_bytes);
        }
    }

    #[test]
    fn segment_ids_are_sequential() {
        let segs = build_segments(8, 8000, 0, true, 0);
        for (i, seg) in segs.iter().enumerate() {
            assert_eq!(seg.id, i as u32);
        }
    }

    #[test]
    fn speed_distributed_evenly() {
        let segs = build_segments(4, 4000, 0, true, 1000);
        for seg in &segs {
            assert_eq!(seg.speed, 250);
        }
    }

    #[test]
    fn uneven_split_remainder_goes_to_last() {
        let segs = build_segments(3, 1000, 0, true, 0);
        assert_eq!(segs[0].total_bytes, 333);
        assert_eq!(segs[1].total_bytes, 333);
        assert_eq!(segs[2].total_bytes, 334);
    }

    // ── shell_split ───────────────────────────────────────────────────────

    #[test]
    fn simple_space_separated() {
        assert_eq!(shell_split("a b c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn multiple_spaces_treated_as_one() {
        assert_eq!(shell_split("a   b"), vec!["a", "b"]);
    }

    #[test]
    fn double_quoted_arg_preserves_spaces() {
        let result = shell_split("cmd \"hello world\" end");
        assert_eq!(result, vec!["cmd", "hello world", "end"]);
    }

    #[test]
    fn single_quoted_arg_preserves_spaces() {
        let result = shell_split("cmd 'hello world' end");
        assert_eq!(result, vec!["cmd", "hello world", "end"]);
    }

    #[test]
    fn double_quote_escape() {
        let result = shell_split(r#"cmd "hello \"world\"""#);
        assert_eq!(result, vec!["cmd", "hello \"world\""]);
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(shell_split(""), Vec::<String>::new());
    }

    #[test]
    fn only_whitespace_returns_empty() {
        assert_eq!(shell_split("   "), Vec::<String>::new());
    }

    #[test]
    fn mixed_quoted_and_unquoted() {
        let result = shell_split("wget --header \"X-Token: abc\" url");
        assert_eq!(result, vec!["wget", "--header", "X-Token: abc", "url"]);
    }

    #[test]
    fn trailing_argument_not_dropped() {
        let result = shell_split("a b c");
        assert_eq!(result.len(), 3);
    }

    #[test]
    fn leading_whitespace_not_panic() {
        let result = shell_split("   a b");
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn single_quote_no_escape() {
        let result = shell_split("a 'b\\c'");
        assert_eq!(result, vec!["a", "b\\c"]);
    }

    // ── mime_for_path ─────────────────────────────────────────────────────

    #[test]
    fn html_mime() {
        assert_eq!(mime_for_path("index.html"), "text/html; charset=utf-8");
    }

    #[test]
    fn css_mime() {
        assert_eq!(mime_for_path("style.css"), "text/css; charset=utf-8");
    }

    #[test]
    fn js_mime() {
        assert_eq!(
            mime_for_path("app.js"),
            "application/javascript; charset=utf-8"
        );
    }

    #[test]
    fn json_mime() {
        assert_eq!(mime_for_path("data.json"), "application/json");
    }

    #[test]
    fn png_mime() {
        assert_eq!(mime_for_path("icon.png"), "image/png");
    }

    #[test]
    fn svg_mime() {
        assert_eq!(mime_for_path("logo.svg"), "image/svg+xml");
    }

    #[test]
    fn woff2_mime() {
        assert_eq!(mime_for_path("font.woff2"), "font/woff2");
    }

    #[test]
    fn wasm_mime() {
        assert_eq!(mime_for_path("module.wasm"), "application/wasm");
    }

    #[test]
    fn unknown_ext_returns_octet_stream() {
        assert_eq!(mime_for_path("file.xyz"), "application/octet-stream");
    }

    #[test]
    fn no_ext_returns_octet_stream() {
        assert_eq!(mime_for_path("Makefile"), "application/octet-stream");
    }

    #[test]
    fn mime_case_insensitive() {
        assert_eq!(mime_for_path("Index.HTML"), "text/html; charset=utf-8");
    }

    // ── push_arg ──────────────────────────────────────────────────────────

    #[test]
    fn push_arg_appends_flag_and_value() {
        let mut args = vec!["dl".to_string()];
        push_arg(&mut args, "--threads", "8");
        assert_eq!(args, vec!["dl", "--threads", "8"]);
    }

    #[test]
    fn push_arg_empty_value() {
        let mut args: Vec<String> = Vec::new();
        push_arg(&mut args, "--output", "");
        assert_eq!(args, vec!["--output", ""]);
    }
}
