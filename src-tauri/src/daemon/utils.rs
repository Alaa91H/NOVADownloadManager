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
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let authority = without_scheme.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err("SSRF blocked: URL contains userinfo (e.g. user@host)".to_string());
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() || host == "localhost" {
        return Err("Host is empty or localhost".to_string());
    }
    fn is_internal_ip(ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_multicast()
                    || v4.is_unspecified()
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
                    || v6.is_multicast()
                    || v6.is_unspecified()
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
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

// ═══════════════════════════════════════════════════════════════════════════
// Shared HTTP header parsing utilities
// RFC 3230 / 5987 / 6249 / 7230 / 7232 / 7233 / 9110 / 9530
// ═══════════════════════════════════════════════════════════════════════════

/// Minimal base64 decoder for HTTP digest header values.
/// RFC 3230 §4.1 / RFC 9530 §3: digests are transmitted as
/// `sha-256=:BASE64VALUE:` (structured-field binary).
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: [i8; 128] = [
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1,
        -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4,
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1,
        -1, -1, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
        46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
    ];
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for &byte in input.as_bytes() {
        if byte == b'\n' || byte == b'\r' || byte == b' ' || byte == b'=' {
            continue;
        }
        let val = *TABLE.get(byte as usize)?;
        if val < 0 {
            return None;
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buf >> bits) as u8);
        }
    }
    Some(result)
}

/// Extract a SHA-256 digest from a `Digest` / `Content-Digest` /
/// `Repr-Digest` header value (RFC 3230 / RFC 9530).
///
/// Supports both structured-field base64 (`:BASE64:`) and hex formats.
/// Returns the lower-case hex-encoded 64-char digest, or `None`.
pub fn parse_sha256_digest(value: &str) -> Option<String> {
    for part in value.split(',') {
        let part = part.trim();
        let lower = part.to_ascii_lowercase();
        if let Some(rest) = lower
            .strip_prefix("sha-256=")
            .or_else(|| lower.strip_prefix("sha256="))
        {
            let raw = part[part.len() - rest.len()..].trim().trim_matches(':');
            if raw.is_empty() {
                continue;
            }
            // Structured-field form: `:BASE64:` → decode to hex.
            if let Some(bytes) = base64_decode(raw) {
                let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
                if hex.len() == 64 {
                    return Some(hex);
                }
            }
            // Plain hex form.
            if raw.len() == 64 && raw.chars().all(|c| c.is_ascii_hexdigit()) {
                return Some(raw.to_ascii_lowercase());
            }
        }
    }
    None
}

/// Extract a SHA-256 digest from a `reqwest::HeaderMap`.
/// Checks `Content-Digest`, `Digest`, and `Repr-Digest` in order (RFC 3230 / RFC 9530).
pub fn extract_digest_from_headers(headers: &reqwest::header::HeaderMap) -> Option<String> {
    for name in &["content-digest", "digest", "repr-digest"] {
        if let Some(value) = headers.get(*name).and_then(|v| v.to_str().ok()) {
            if let Some(d) = parse_sha256_digest(value) {
                return Some(d);
            }
        }
    }
    None
}

/// Parsed mirror from a `Link: <url>; rel=duplicate; pri=N` header (RFC 6249).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedLinkMirror {
    pub url: String,
    /// Mirror priority from the `pri` parameter (lower = higher priority).
    /// Defaults to 1 when absent, per RFC 6249 §4.
    pub priority: u32,
}

/// Extract mirror URLs from a `Link` header value (RFC 6249 / RFC 8288).
///
/// Parses `Link: <url>; rel=duplicate` with optional `pri=N`.
///
/// **RFC 6249 compliance:** Only the `rel` parameter value is compared
/// case-insensitively; the URL itself is never lowercased because URL
/// paths may be case-sensitive.
pub fn parse_link_mirrors(value: &str) -> Vec<ParsedLinkMirror> {
    let mut mirrors = Vec::new();
    for link in value.split(',') {
        let link = link.trim();
        if link.is_empty() {
            continue;
        }
        let Some(start) = link.find('<') else {
            continue;
        };
        let Some(end) = link[start + 1..].find('>') else {
            continue;
        };
        let url = &link[start + 1..start + 1 + end];
        if !url.starts_with("http") {
            continue;
        }
        // Parse semicolon-separated parameters after the URL.
        let params_part = link[start + 1 + end + 1..].trim();
        let mut is_duplicate = false;
        let mut priority: u32 = 1;
        for param in params_part.split(';') {
            let param = param.trim();
            if param.is_empty() {
                continue;
            }
            if let Some((key, val)) = param.split_once('=') {
                let key = key.trim().to_ascii_lowercase();
                let val = val.trim().trim_matches('"');
                if key == "rel" && val.eq_ignore_ascii_case("duplicate") {
                    is_duplicate = true;
                }
                if key == "pri" {
                    priority = val.parse::<u32>().unwrap_or(1).max(1);
                }
            }
        }
        if is_duplicate {
            mirrors.push(ParsedLinkMirror {
                url: url.to_string(),
                priority,
            });
        }
    }
    mirrors
}

/// Extract the first mirror URL from a single `Link` header fragment (RFC 6249).
/// Used by streaming header callbacks that process one line at a time.
pub fn parse_link_duplicate_single(link: &str) -> Option<String> {
    parse_link_mirrors(link).into_iter().next().map(|m| m.url)
}

/// Parse an HTTP-date `Retry-After` header value into seconds from now
/// (RFC 9110 §15.5.3).
///
/// Accepts IMF-fixdate: `Wed, 21 Oct 2015 07:28:00 GMT`.
/// Uses `chrono::DateTime::parse_from_rfc2822` which strictly validates
/// the RFC 2822 / IMF-fixdate format (unlike `%Z` which accepts arbitrary
/// timezone abbreviations like `EST` that are NOT valid per RFC 9110).
pub fn parse_retry_after_date(value: &str) -> Option<u64> {
    let value = value.trim();
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(value) {
        // RFC 9110 §15.5.3: IMF-fixdate requires GMT specifically.
        // chrono accepts abbreviated timezones like EST, but those are
        // NOT valid per RFC 9110 — only numeric offsets or "GMT" are valid.
        if date.offset().local_minus_utc() != 0 {
            return None;
        }
        let now = chrono::Utc::now();
        let diff = date.signed_duration_since(now);
        if diff.num_seconds() > 0 {
            Some(diff.num_seconds() as u64)
        } else {
            Some(0)
        }
    } else {
        None
    }
}

/// Check whether an ETag is a strong validator (RFC 7232 §2.3).
/// Strong ETags do NOT start with the `W/` prefix.
pub fn is_strong_etag(etag: &str) -> bool {
    !etag.trim().starts_with("W/")
}

// ── HTML meta-refresh helpers (moved from routes.rs to break circular dependency) ──

/// Parse HTML content for `<meta http-equiv="refresh" content="5;URL='...'">`
/// patterns commonly used by mirrors that redirect via
/// HTML rather than HTTP 3xx. Returns the redirected URL if found.
pub(crate) fn parse_meta_refresh_url(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for tag_match in lower.match_indices("<meta") {
        let start = tag_match.0;
        let Some(end) = lower[start..].find('>') else {
            continue;
        };
        let tag_lower = &lower[start..start + end + 1];
        let tag_orig = &html[start..start + end + 1];
        if !(tag_lower.contains("http-equiv") && tag_lower.contains("refresh")) {
            continue;
        }
        // `content="<delay>; url=<target>"` — find the URL and delimit it at the
        // matching/closing quote, whitespace or the end of the tag. Handles both
        // quoted (`url='...'`) and bare (`url=...`) forms.
        let Some(pos) = tag_lower.rfind("url=") else {
            continue;
        };
        let after = tag_orig[pos + 4..].trim_start();
        let (opening_quote, body) = match after.chars().next() {
            Some(q @ ('\'' | '"')) => (Some(q), &after[q.len_utf8()..]),
            _ => (None, after),
        };
        let end_idx = body
            .find(|c: char| {
                c == '>' || c.is_whitespace() || c == '"' || c == '\'' || Some(c) == opening_quote
            })
            .unwrap_or(body.len());
        let raw = body[..end_idx].trim();
        if !raw.is_empty() {
            // Meta-refresh URLs are HTML-escaped (e.g. `&amp;` in query strings).
            return Some(decode_html_entities(raw));
        }
    }
    None
}

/// Decode the small set of HTML entities that appear in redirect/link URLs.
pub(crate) fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&#x26;", "&")
        .replace("&#x3d;", "=")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

/// Resolve a meta-refresh redirect URL relative to the page URL if needed.
pub(crate) fn refreshed_url(refresh: String, page_url: &str) -> String {
    if refresh.starts_with("http://") || refresh.starts_with("https://") {
        refresh
    } else if let Some(base) = page_url.rsplit_once('/') {
        format!(
            "{}/{}",
            base.0.trim_end_matches('/'),
            refresh.trim_start_matches('/')
        )
    } else {
        refresh
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

    // ── base64_decode ────────────────────────────────────────────────────

    #[test]
    fn base64_decode_hello() {
        let decoded = base64_decode("SGVsbG8=").unwrap();
        assert_eq!(decoded, b"Hello");
    }

    #[test]
    fn base64_decode_empty() {
        assert!(base64_decode("").is_none());
    }

    #[test]
    fn base64_decode_with_whitespace() {
        let decoded = base64_decode("SG V\nsb\r\nG8=").unwrap();
        assert_eq!(decoded, b"Hello");
    }

    // ── parse_sha256_digest ──────────────────────────────────────────────

    #[test]
    fn parse_sha256_digest_base64() {
        // 32 zero bytes in base64 = "AAAA..." (44 chars).
        let b64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let value = format!("sha-256=:{}:", b64);
        let result = parse_sha256_digest(&value).unwrap();
        assert_eq!(result.len(), 64);
        assert!(result.chars().all(|c| c == '0'));
    }

    #[test]
    fn parse_sha256_digest_hex() {
        let hex = "a".repeat(64);
        let result = parse_sha256_digest(&format!("SHA-256={}", hex)).unwrap();
        assert_eq!(result, hex);
    }

    #[test]
    fn parse_sha256_digest_none_on_empty() {
        assert!(parse_sha256_digest("").is_none());
    }

    // ── parse_link_mirrors ───────────────────────────────────────────────

    #[test]
    fn parse_link_mirrors_basic() {
        let mirrors = parse_link_mirrors(r#"<https://mirror1.example.com/file>; rel="duplicate""#);
        assert_eq!(mirrors.len(), 1);
        assert_eq!(mirrors[0].url, "https://mirror1.example.com/file");
        assert_eq!(mirrors[0].priority, 1);
    }

    #[test]
    fn parse_link_mirrors_with_pri() {
        let mirrors =
            parse_link_mirrors(r#"<https://mirror1.example.com/file>; rel="duplicate"; pri=2"#);
        assert_eq!(mirrors.len(), 1);
        assert_eq!(mirrors[0].priority, 2);
    }

    #[test]
    fn parse_link_mirrors_multiple() {
        let mirrors = parse_link_mirrors(
            r#"<https://a.com/f>; rel="duplicate"; pri=1, <https://b.com/f>; rel="duplicate"; pri=2"#,
        );
        assert_eq!(mirrors.len(), 2);
        assert_eq!(mirrors[0].priority, 1);
        assert_eq!(mirrors[1].priority, 2);
    }

    #[test]
    fn parse_link_mirrors_url_not_lowercased() {
        let mirrors = parse_link_mirrors(
            r#"<https://Mirror.Example.COM/Path/FileName.ZIP>; rel="duplicate""#,
        );
        assert_eq!(mirrors.len(), 1);
        assert_eq!(
            mirrors[0].url,
            "https://Mirror.Example.COM/Path/FileName.ZIP"
        );
    }

    #[test]
    fn parse_link_mirrors_skips_non_http() {
        let mirrors = parse_link_mirrors(r#"<ftp://mirror.example.com/file>; rel="duplicate""#);
        assert!(mirrors.is_empty());
    }

    // ── is_strong_etag ─────────────────────────────────────────────────

    #[test]
    fn strong_etag() {
        assert!(is_strong_etag(r#""abc123""#));
    }

    #[test]
    fn weak_etag() {
        assert!(!is_strong_etag(r#"W/"abc123""#));
    }

    // ── parse_retry_after_date ───────────────────────────────────────────

    #[test]
    fn parse_retry_after_date_invalid() {
        assert!(parse_retry_after_date("not-a-date").is_none());
    }

    #[test]
    fn parse_retry_after_date_rejects_non_gmt() {
        // "Wed, 21 Oct 2015 07:28:00 EST" should be rejected — IMF-fixdate
        // requires GMT (RFC 9110 §15.5.3).
        assert!(parse_retry_after_date("Wed, 21 Oct 2015 07:28:00 EST").is_none());
    }

    // ── parse_meta_refresh_url ───────────────────────────────────────────

    #[test]
    fn meta_refresh_basic() {
        let html =
            r#"<meta http-equiv="refresh" content="5;URL='https://example.com/dl/file.zip'">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("https://example.com/dl/file.zip".to_string())
        );
    }

    #[test]
    fn meta_refresh_bare_url() {
        let html = r#"<META HTTP-EQUIV="refresh" CONTENT="0;URL=https://example.com/redir">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("https://example.com/redir".to_string())
        );
    }

    #[test]
    fn meta_refresh_entities() {
        let html = r#"<meta http-equiv="refresh" content="0;URL=a.cgi?x=1&amp;y=2">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("a.cgi?x=1&y=2".to_string())
        );
    }

    #[test]
    fn meta_refresh_none() {
        assert!(parse_meta_refresh_url("<html><head></head></html>").is_none());
    }

    // ── decode_html_entities ─────────────────────────────────────────────

    #[test]
    fn decode_entities() {
        assert_eq!(decode_html_entities("a&amp;b"), "a&b");
        assert_eq!(decode_html_entities("&#38;x"), "&x");
        assert_eq!(decode_html_entities("&#x26;x"), "&x");
        assert_eq!(decode_html_entities("a&amp; b=&#39;c&#39;"), "a& b='c'");
    }

    // ── refreshed_url ────────────────────────────────────────────────────

    #[test]
    fn refreshed_url_absolute() {
        assert_eq!(
            refreshed_url(
                "https://example.com/redir".into(),
                "https://example.com/page"
            ),
            "https://example.com/redir"
        );
    }

    #[test]
    fn refreshed_url_relative() {
        assert_eq!(
            refreshed_url("file.zip".into(), "https://example.com/dl/page"),
            "https://example.com/dl/file.zip"
        );
    }

    #[test]
    fn refreshed_url_leading_slash() {
        // Leading-slash paths are joined relative to the base directory, not root.
        // "dl/" + "file.zip" => "dl/file.zip"
        assert_eq!(
            refreshed_url("/file.zip".into(), "https://example.com/dl/page"),
            "https://example.com/dl/file.zip"
        );
    }
}
