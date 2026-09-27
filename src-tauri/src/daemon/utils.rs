use crate::daemon::types::Segment;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::process::Command;

/// Browser-like UA avoids 403/Forbidden from CDNs and download mirrors that
/// block non-browser clients (e.g. some anti-hotlink middleware).
pub const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

/// Lock a Mutex and return the guard, or log error and recover on poison.
///
/// Recovery is safe here because our mutexes protect simple data (`HashMaps`)
/// and we always prefer availability over correctness after poison.
#[macro_export]
macro_rules! lock_or_err {
    ($mutex:expr) => {{
        static POISON_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        match $mutex.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let count = POISON_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                log::error!(
                    "Mutex poisoned at {}:{} ({}), recovering — data may be inconsistent \
                     (poison event #{}) — if you see data corruption, restart the application",
                    file!(),
                    line!(),
                    poisoned,
                    count
                );
                poisoned.into_inner()
            }
        }
    }};
}

/// Validate that a URL targets an external (non-private) host to prevent SSRF.
/// Rejects empty URLs, non-http(s) schemes, and private/loopback/link-local/multicast IPs.
pub fn is_safe_target_url(raw: &str) -> Result<(), String> {
    let _ = resolve_and_check_url(raw)?;
    Ok(())
}

pub fn is_safe_target_url_pinned(raw: &str) -> Result<(IpAddr, String), String> {
    let (ip, host, port) = resolve_and_check_url(raw)?;
    // curl's `--resolve HOST:PORT:ADDRESS` requires IPv6 literals (both the
    // host and the address) to be enclosed in brackets (`[2001:db8::1]`).
    // Emitting a bare IPv6 here produced `host:443:2001:41d0:...`, which
    // every downstream parser (and curl itself) read as four separate
    // colon-delimited fields and rejected — downloads to IPv6-first hosts
    // failed before they started.
    let host_display = if host.parse::<IpAddr>().is_ok_and(|h| h.is_ipv6()) {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let pinned = match ip {
        IpAddr::V6(_) => format!("{host_display}:{port}:[{ip}]"),
        _ => format!("{host_display}:{port}:{ip}"),
    };
    Ok((ip, pinned))
}

fn resolve_and_check_url(raw: &str) -> Result<(IpAddr, String, u16), String> {
    if raw.is_empty() {
        return Err("URL is empty".to_owned());
    }
    let url = raw.trim();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http(s) URLs are allowed for network requests".to_owned());
    }
    let is_tls = url.starts_with("https://");
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let authority = without_scheme.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err("SSRF blocked: URL contains userinfo (e.g. user@host)".to_owned());
    }
    // The host may be a bracketed IPv6 literal (`[2606:2800:...]` or
    // `[2606:2800:...]:443`). A naive `.split(':').next()` on such an
    // authority returns only the fragment before the first colon (`2606`),
    // which then fails DNS resolution. Parse the bracket form explicitly.
    let (host_raw, port_raw) = if let Some(rest) = authority.strip_prefix('[') {
        match rest.find(']') {
            Some(end) => {
                let host = &rest[..end];
                let after = rest[end + 1..].trim_start_matches(':');
                (host, after)
            }
            None => (rest, ""),
        }
    } else {
        let mut parts = authority.splitn(2, ':');
        (parts.next().unwrap_or(""), parts.next().unwrap_or(""))
    };
    let host = host_raw.trim();
    if host.is_empty() || (host == "localhost" && !private_network_allowed()) {
        return Err("Host is empty or localhost".to_owned());
    }
    let port: u16 = port_raw
        .split('/')
        .next()
        .unwrap_or(port_raw)
        .parse()
        .ok()
        .unwrap_or(if is_tls { 443 } else { 80 });
    // Try to parse as IP first
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_internal_ip(ip) && !private_network_allowed() {
            return Err(format!("SSRF blocked: URL targets internal IP {ip}"));
        }
        return Ok((ip, host.to_owned(), port));
    }
    // Resolve hostname and check all resolved addresses
    let allow_private = private_network_allowed();
    let addr_str = format!("{host}:{port}");
    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve host '{host}': {e}"))?;
    let mut resolved: Option<IpAddr> = None;
    for addr in addrs {
        let ip = addr.ip();
        if is_internal_ip(ip) && !allow_private {
            return Err(format!(
                "SSRF blocked: host '{host}' resolves to internal IP {ip}"
            ));
        }
        if resolved.is_none() {
            resolved = Some(ip);
        }
    }
    let ip = resolved.ok_or_else(|| format!("Could not resolve host '{host}'"))?;
    Ok((ip, host.to_owned(), port))
}

/// Whether network requests to private/loopback addresses are permitted.
///
/// OFF by default — the daemon must never reach internal networks in
/// production (SSRF protection). Setting `NOVA_ALLOW_PRIVATE_NETWORK=1` (or
/// `true`) lifts that restriction so the engine can be tested against local
/// mirrors and development servers. Read lazily per call so the flag can be
/// toggled without a restart.
pub fn private_network_allowed() -> bool {
    parse_private_network_flag(std::env::var("NOVA_ALLOW_PRIVATE_NETWORK").ok().as_deref())
}

/// Pure flag parser (unit-testable without touching the process environment).
fn parse_private_network_flag(value: Option<&str>) -> bool {
    value.is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))
}

/// Returns true if the IP is internal/private (loopback, private, link-local,
/// multicast, unspecified, or IPv6 ULA). Shared by URL and resolve-entry checks.
pub const fn is_internal_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_unspecified()
                // Bogon / TEST-NET ranges
                || (o[0] == 192 && o[1] == 0 && o[2] == 2)
                || (o[0] == 198 && o[1] == 51 && o[2] == 100)
                || (o[0] == 203 && o[1] == 0 && o[2] == 113)
                || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.is_multicast()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || is_ipv4_mapped_internal(&v6)
        }
    }
}

/// Detect IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) that point at internal IPv4.
const fn is_ipv4_mapped_internal(v6: &Ipv6Addr) -> bool {
    let segs = v6.segments();
    // ::ffff:a.b.c.d => segments [0,0,0,0,0,ffff,a,b]
    if segs[0] == 0
        && segs[1] == 0
        && segs[2] == 0
        && segs[3] == 0
        && segs[4] == 0
        && segs[5] == 0xffff
    {
        let v4 = Ipv4Addr::new(
            (segs[6] >> 8) as u8,
            segs[6] as u8,
            (segs[7] >> 8) as u8,
            segs[7] as u8,
        );
        return v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified();
    }
    false
}

/// Validate a curl `--resolve` / `--connect-to` entry to prevent SSRF bypass.
///
/// curl resolve syntax: `HOST:PORT:ADDRESS` (ADDRESS may be `+` to keep DNS).
/// curl connect-to syntax: `HOST:PORT:CONNECT_HOST:CONNECT_PORT`.
/// We reject any entry whose target `ADDRESS/CONNECT_HOST` resolves to an
/// internal IP, mirroring `is_safe_target_url`'s policy.
pub fn is_safe_resolve_entry(entry: &str) -> Result<(), String> {
    // Resolve entries are `HOST:PORT:ADDRESS`; connect-to entries are
    // `HOST:PORT:CONNECT_HOST:CONNECT_PORT`. An IPv6 ADDRESS literal itself
    // contains colons (`2001:41d0:242:d300::` or bracketed `[2001:db8::1]`),
    // so the target is everything AFTER THE SECOND colon — never a naive
    // per-colon split, which misread `host:443:2001:41d0:...` as an entry
    // whose address was just `2001` and failed the whole download.
    let Some(after_prefix) = entry.splitn(3, ':').nth(2) else {
        return Err(format!("Invalid resolve/connect-to entry: '{entry}'"));
    };
    let mut target = after_prefix.trim();
    // Strip a bracketed IPv6 literal to its bare address
    // (`[2001:db8::1]` or `[2001:db8::1]:443` → `2001:db8::1`).
    if let Some(rest) = target.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            target = &rest[..end];
        }
    } else if target.parse::<IpAddr>().is_err() && target != "+" {
        // connect-to form: `CONNECT_HOST:CONNECT_PORT` → `CONNECT_HOST`.
        // Only strip a trailing `:PORT` when the remainder is NOT itself an
        // IPv6 literal — a bare IPv6 like `2001:41d0:242:d300::` ends in
        // `::` and would be mangled by a naive rfind(':')
        // (the last field is empty, so stripping it corrupts the address).
        if let Some(idx) = target.rfind(':') {
            let (head, tail) = target.split_at(idx);
            if tail[1..].bytes().all(|b| b.is_ascii_digit()) {
                target = head;
            }
        }
    }
    let target = target.trim();
    if target.is_empty() {
        return Err(format!(
            "Empty address in resolve/connect-to entry: '{entry}'"
        ));
    }
    if target == "+" {
        return Ok(());
    }
    if let Ok(ip) = target.parse::<IpAddr>() {
        if is_internal_ip(ip) && !private_network_allowed() {
            return Err(format!(
                "SSRF blocked: resolve/connect-to entry '{entry}' targets internal IP {ip}"
            ));
        }
        return Ok(());
    }
    // Hostname target — resolve and check all addresses.
    let allow_private = private_network_allowed();
    let addr_str = format!("{target}:443");
    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve connect-to host '{target}': {e}"))?;
    for addr in addrs {
        if is_internal_ip(addr.ip()) && !allow_private {
            return Err(format!(
                "SSRF blocked: connect-to host '{}' resolves to internal IP {}",
                target,
                addr.ip()
            ));
        }
    }
    Ok(())
}

#[inline]
/// Infer a file category from a filename or extension.
///
/// This is the single source of truth for extension→category mapping in the
/// daemon. Previously, `infer_file_type` (utils.rs) and
/// `map_candidate_file_type` (extension.rs) maintained diverging maps that
/// classified the same file differently depending on the code path — e.g.
/// `.iso` was "compressed" via `infer_file_type` but "app" via the browser
/// extension, and `.xz`/`.opus`/`.appimage` were only in one map.
pub fn infer_file_type(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    file_type_from_extension(ext)
}

/// Map a bare extension (lowercase, no dot) to a file category. Used by both
/// `infer_file_type` and the browser-extension candidate mapper so that
/// every code path produces the same classification.
///
/// This is the SINGLE source of truth for extension→category mapping. The
/// recognition set (what counts as a "direct file link" at all) lives in
/// `is_recognizable_download_extension`; every extension that maps to a real
/// category here is automatically a recognized download file, while the
/// categories that have no UI bucket (images, fonts, subtitles, libraries)
/// map to `other` but are still recognized as direct files.
pub fn file_type_from_extension(ext: &str) -> &'static str {
    match ext {
        // Archives
        "zip" | "rar" | "7z" | "tar" | "gz" | "tgz" | "bz2" | "tbz2" | "xz" | "txz" | "zst"
        | "lz" | "lzma" | "arj" | "lzh" | "cpio" | "iso" | "cab" | "nupkg" | "img" | "bin" => {
            "compressed"
        }
        // Programs / installers
        "exe" | "msi" | "msix" | "appx" | "apk" | "ipa" | "dmg" | "pkg" | "appimage"
        | "flatpak" | "snap" | "deb" | "rpm" | "run" | "bat" | "cmd" | "sh" | "ps1" | "py"
        | "whl" | "egg" | "jar" | "war" | "xpi" | "crx" | "vsix" => "program",
        // Documents
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
        | "rtf" | "txt" | "md" | "csv" | "tsv" | "json" | "xml" | "tex" | "log" | "yaml"
        | "yml" | "epub" | "mobi" | "azw3" => "document",
        // Video
        "mp4" | "mkv" | "avi" | "mov" | "flv" | "wmv" | "webm" | "ts" | "m2ts" | "mts" | "m4v"
        | "mpg" | "mpeg" | "3gp" | "ogv" | "rm" | "rmvb" | "vob" | "f4v" => "video",
        // Audio
        "mp3" | "flac" | "wav" | "ogg" | "m4a" | "aac" | "wma" | "opus" | "aiff" | "alac"
        | "m4b" | "mid" | "midi" | "amr" | "ape" | "wv" | "ac3" | "dts" | "ra" | "mka" => "audio",
        _ => "other",
    }
}

/// True when the extension identifies a file the download engine can fetch
/// directly (a real file rather than an HTML page or script endpoint).
///
/// This is the SINGLE source of truth for "does this link point at a file?"
/// shared by the fast-path checker (`has_recognizable_extension` in
/// routes/downloads.rs), the HTML interstitial link extractor
/// (`extract_direct_download_links`), and query-string filename detection
/// (`file_name_from_query`). Previously each caller maintained its own
/// `matches!` list, so a `.png` link was accepted by the fast path but
/// dropped by the link extractor depending on which list it landed in.
/// Expects a lowercase, dot-less extension (`file_type_from_extension`
/// convention).
pub fn is_recognizable_download_extension(ext: &str) -> bool {
    matches!(
        ext,
        // Executables & installers
        "exe" | "msi" | "msix" | "appx" | "dmg" | "pkg" | "deb" | "rpm" | "apk" | "ipa"
            | "appimage" | "flatpak" | "snap" | "run" | "sh" | "bat" | "cmd" | "ps1"
            | "py" | "whl" | "egg" | "jar" | "war" | "xpi" | "crx" | "nupkg" | "vsix"
        // Archives
        | "zip" | "7z" | "rar" | "tar" | "gz" | "tgz" | "bz2" | "tbz2" | "xz" | "txz"
            | "zst" | "lz" | "lzma" | "arj" | "lzh" | "cpio" | "cab" | "iso" | "img"
            | "bin"
        // Documents
        | "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods"
            | "odp" | "rtf" | "txt" | "md" | "csv" | "tsv" | "json" | "xml" | "tex"
            | "log" | "yaml" | "yml" | "epub" | "mobi" | "azw3"
        // Media — video
        | "mp4" | "mkv" | "avi" | "mov" | "flv" | "webm" | "wmv" | "m4v" | "mpg"
            | "mpeg" | "3gp" | "ts" | "m2ts" | "mts" | "ogv" | "rm" | "rmvb" | "vob"
            | "f4v"
        // Media — audio
        | "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" | "opus" | "aiff"
            | "alac" | "m4b" | "mid" | "midi" | "amr" | "ape" | "wv" | "ac3" | "dts"
            | "ra" | "mka"
        // Media — images
        | "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "tiff" | "tif"
            | "heic" | "avif" | "ico" | "raw" | "psd" | "ai" | "eps" | "jxl"
        // Fonts
        | "ttf" | "otf" | "woff" | "woff2" | "eot"
        // Subtitles / captions
        | "srt" | "vtt" | "ass" | "ssa" | "sub"
        // Libraries & data
        | "dll" | "so" | "dylib" | "lib" | "a" | "o" | "dat" | "db" | "sqlite"
            | "sqlite3" | "pem" | "crt" | "key" | "p12" | "pfx"
        // Other downloadable
        | "torrent"
    )
}

/// Query-string parameter names that commonly carry the real file name on
/// scripted download endpoints (`/download.php?file=setup.exe`,
/// `/get?id=7&filename=report.pdf`). The value is a file name with an
/// extension — unlike the path, which usually ends in `.php`/`.asp`.
const QUERY_FILENAME_KEYS: &[&str] = &[
    "file", "filename", "fname", "name", "fn", "dl", "download", "saveas", "path", "url",
];

/// Extract a file name from a URL's query string when a well-known filename
/// parameter (`?file=setup.exe`, `?filename=report.pdf`) names a recognizable
/// file. Returns `None` when no parameter names a file (page URLs, API
/// endpoints). The value is percent-decoded and reduced to its final path
/// segment so `?file=/dir/foo.zip` still works.
pub fn file_name_from_query(url: &str) -> Option<String> {
    let query = url.split('?').nth(1)?;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if !QUERY_FILENAME_KEYS.contains(&key.as_str()) {
            continue;
        }
        let mut decoded = percent_decode(value);
        // Strip any URL fragment (`?file=foo.zip#section`) — the fragment is
        // page state, not part of the file name.
        if let Some(idx) = decoded.find('#') {
            decoded.truncate(idx);
        }
        // Reduce to the final path segment, honoring both `/` and `\` so an
        // encoded or literal backslash cannot smuggle traversal-looking
        // segments into the name (the caller sanitizes anyway, but the
        // helper should not manufacture them).
        let name = decoded.rsplit(['/', '\\']).next().unwrap_or(&decoded);
        let name = name.trim().trim_matches('"').trim_matches('\'');
        if name.is_empty() {
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if is_recognizable_download_extension(&ext) {
            return Some(name.to_owned());
        }
    }
    None
}

/// Percent-decode a URL component (`%20` → space, `%2F` → `/`, `%C3%A9` → é)
/// into UTF-8, replacing invalid sequences lossily. Shared by the query
/// filename detector and the route-level `file_name_from_url`.
pub fn percent_decode(input: &str) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) =
                u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
            {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[inline]
pub fn build_segments(connections: u32, total: u64, downloaded: u64, speed: u64) -> Vec<Segment> {
    if total == 0 {
        return vec![Segment {
            id: 0,
            progress: 0.0,
            downloaded_bytes: downloaded,
            total_bytes: 0,
            active: true,
            speed,
            start_byte: 0,
            end_byte: 0,
        }];
    }
    let per_seg = total / u64::from(connections.max(1));
    let mut segs = Vec::new();
    for i in 0..connections {
        let seg_start = u64::from(i) * per_seg;
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
            speed: speed / u64::from(connections.max(1)),
            start_byte: seg_start,
            end_byte: seg_end,
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
    args.push(flag.to_owned());
    args.push(value.to_owned());
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
    // Send graceful shutdown (CTRL_BREAK_EVENT) first — taskkill without /F
    // sends CTRL_BREAK_EVENT to the process group, giving yt-dlp/ffmpeg a
    // chance to clean up .part files and child processes.
    {
        let mut cmd = std::process::Command::new("taskkill");
        hide_command_window(&mut cmd);
        if let Err(e) = cmd
            .args(["/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            log::warn!("kill_process: graceful taskkill failed for PID {pid}: {e}");
        }
    }
    std::thread::sleep(std::time::Duration::from_secs(2));
    // Then force kill
    {
        let mut cmd = std::process::Command::new("taskkill");
        hide_command_window(&mut cmd);
        if let Err(e) = cmd
            .args(["/F", "/PID", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            log::warn!("kill_process: force taskkill failed for PID {pid}: {e}");
        }
    }
}

#[cfg(not(windows))]
pub fn kill_process(pid: u32) {
    // Send SIGTERM first for graceful shutdown
    {
        if let Err(e) = std::process::Command::new("kill")
            .args(["-15", &pid.to_string()])
            .spawn()
        {
            log::warn!("kill_process: SIGTERM failed for PID {}: {}", pid, e);
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(2000));
    // Then force kill
    {
        if let Err(e) = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .spawn()
        {
            log::warn!("kill_process: SIGKILL failed for PID {}: {}", pid, e);
        }
    }
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
                let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
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
                url: url.to_owned(),
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

/// Check whether an `ETag` is a strong validator (RFC 7232 §2.3).
/// Strong `ETags` do NOT start with the `W/` prefix.
pub fn is_strong_etag(etag: &str) -> bool {
    !etag.trim().starts_with("W/")
}

// ── HTML meta-refresh helpers (moved from routes.rs to break circular dependency) ──

/// Parse HTML content for `<meta http-equiv="refresh" content="5;URL='...'">`
/// patterns commonly used by mirrors that redirect via
/// HTML rather than HTTP 3xx. Returns the redirected URL if found.
pub fn parse_meta_refresh_url(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for tag_match in lower.match_indices("<meta") {
        let start = tag_match.0;
        let Some(end) = lower[start..].find('>') else {
            continue;
        };
        let tag_lower = &lower[start..=(start + end)];
        let tag_orig = &html[start..=(start + end)];
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
            // Some sites percent-encode the ENTIRE URL (`URL='http%3A%2F%2Fhost'
            // `%2Ffile.zip'`); `refreshed_url` only recognizes a literal
            // `http://`/`https://` prefix, so such encoded-scheme URLs must be
            // percent-decoded before resolution. Decode ONLY when the raw value
            // starts with an encoded scheme — a partially-encoded target like
            // `https://x.com/dl/file%20name.zip` already carries a literal
            // scheme and its `%20` must be left intact for the HTTP layer, not
            // turned into a raw space here.
            let lower_raw = raw.to_ascii_lowercase();
            let mut decoded = if lower_raw.starts_with("http%3a%2f%2f")
                || lower_raw.starts_with("https%3a%2f%2f")
            {
                percent_decode(raw)
            } else {
                raw.to_owned()
            };
            // Normalize the scheme to lowercase: percent-decoding preserves the
            // original casing (`HTTPS%3A%2F%2F` → `HTTPS://`), but
            // `refreshed_url` only recognizes a literal lowercase `http://` /
            // `https://` prefix, so an uppercase decoded scheme would silently
            // be treated as a relative path.
            if decoded.len() >= 7 {
                if decoded[..7].eq_ignore_ascii_case("http://") {
                    decoded.replace_range(..7, "http://");
                } else if decoded.len() >= 8 && decoded[..8].eq_ignore_ascii_case("https://") {
                    decoded.replace_range(..8, "https://");
                }
            }
            return Some(decode_html_entities(&decoded));
        }
    }
    None
}

/// Decode the small set of HTML entities that appear in redirect/link URLs.
pub fn decode_html_entities(s: &str) -> String {
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
///
/// Use the RFC 3986 resolver instead of joining strings: `/path` is host-rooted,
/// `../path` traverses directories, and query- or fragment-only references retain
/// the current resource path. If the page URL is malformed, preserve the parsed
/// refresh target rather than fabricating a possibly incorrect destination.
pub fn refreshed_url(refresh: String, page_url: &str) -> String {
    reqwest::Url::parse(page_url)
        .ok()
        .and_then(|base| base.join(&refresh).ok())
        .map(|resolved| resolved.to_string())
        .unwrap_or(refresh)
}

/// Extract candidate direct download URLs from an HTML page. Many download
/// sites (Sublime's "thank you" page, SourceForge, GitHub release pages)
/// link the real file via plain `<a href>` anchors instead of a meta-refresh
/// or an HTTP redirect. Returns absolute URLs resolved against `page_url`,
/// filtered to links whose path ends in a recognizable file extension and
/// ranked best-first by platform/architecture hints found in `page_url`
/// (e.g. `?target=win-x64` prefers `.exe`/`.msi` installers).
pub fn extract_direct_download_links(html: &str, page_url: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut candidates: Vec<String> = Vec::new();
    let mut pos = 0usize;
    while let Some(rel) = lower[pos..].find("href") {
        let start = pos + rel;
        let mut j = start + 4;
        while j < lower.len() && lower.as_bytes()[j] == b' ' {
            j += 1;
        }
        if j >= lower.len() || lower.as_bytes()[j] != b'=' {
            pos = start + 4;
            continue;
        }
        j += 1;
        while j < lower.len() && lower.as_bytes()[j] == b' ' {
            j += 1;
        }
        if j >= lower.len() {
            break;
        }
        let q = lower.as_bytes()[j];
        if q != b'"' && q != b'\'' {
            pos = j;
            continue;
        }
        let body_start = j + 1;
        let Some(end_rel) = lower[body_start..].find(q as char) else {
            break;
        };
        let raw = &html[body_start..body_start + end_rel];
        pos = body_start + end_rel + 1;
        let link = decode_html_entities(raw).trim().to_string();
        if link.is_empty()
            || link.starts_with('#')
            || link.starts_with("mailto:")
            || link.starts_with("javascript:")
            || link.starts_with("tel:")
            || link.starts_with("data:")
        {
            continue;
        }
        let absolute = if link.starts_with("http://") || link.starts_with("https://") {
            link
        } else {
            // Full RFC 3986 resolution: a leading "/" href is host-rooted
            // (`https://host/...`), while bare/"../" paths resolve against the
            // page directory. The meta-refresh `refreshed_url` helper joins
            // against the directory only, which is wrong for root-relative
            // anchors like `<a href="/download/app.zip">`.
            reqwest::Url::parse(page_url)
                .ok()
                .and_then(|base| base.join(&link).ok())
                .map(|u| u.to_string())
                .unwrap_or_else(|| refreshed_url(link, page_url))
        };
        let path = absolute.split(['?', '#']).next().unwrap_or(&absolute);
        // SourceForge-style download anchors end in a trailing `/download`
        // segment (`.../files/foo.zip/download?use_mirror=...`) that carries
        // no extension of its own. The real file name — and its recognizable
        // extension — precedes it, so strip the suffix before classification.
        let file_path = path.strip_suffix("/download").unwrap_or(path);
        let ext = file_path
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        // Accept the link when the path ends in a recognizable extension OR a
        // scripted endpoint query (`?file=setup.exe`) names one. Scripted
        // download pages put the real file name in the query, never in the
        // `.php`/`.asp` path.
        if !is_recognizable_download_extension(&ext) && file_name_from_query(&absolute).is_none() {
            continue;
        }
        if !candidates.contains(&absolute) {
            candidates.push(absolute);
        }
    }

    // Rank best-first: match the platform/architecture implied by the page URL.
    let page_lower = page_url.to_ascii_lowercase();
    // NOTE: avoid a bare "win" substring — "darwin" (macOS) contains "win".
    let win = page_lower.contains("windows")
        || page_lower.contains("win-x64")
        || page_lower.contains("win64")
        || page_lower.contains("win32")
        || page_lower.contains("win_");
    let mac =
        page_lower.contains("mac") || page_lower.contains("darwin") || page_lower.contains("osx");
    let linux = page_lower.contains("linux")
        || page_lower.contains("ubuntu")
        || page_lower.contains("debian")
        || page_lower.contains("fedora")
        || page_lower.contains("snap");
    let x64 = page_lower.contains("x64")
        || page_lower.contains("amd64")
        || page_lower.contains("x86_64")
        || page_lower.contains("-64");
    let arm64 = page_lower.contains("arm64") || page_lower.contains("aarch64");

    candidates.sort_by(|a, b| {
        score_link(b, win, mac, linux, x64, arm64).cmp(&score_link(a, win, mac, linux, x64, arm64))
    });
    candidates
}

fn score_link(url: &str, win: bool, mac: bool, linux: bool, x64: bool, arm64: bool) -> i64 {
    let u = url.to_ascii_lowercase();
    // Mirror extract_direct_download_links: a trailing `/download` segment
    // (SourceForge convention) carries no extension, so classify the segment
    // before it for platform scoring.
    let file_path = u.split(['?', '#']).next().unwrap_or(&u);
    let file_path = file_path.strip_suffix("/download").unwrap_or(file_path);
    let mut ext = file_path.rsplit('.').next().unwrap_or("").to_string();
    // Scripted endpoints (`/download.php?file=setup.exe`) hide the real file
    // name in the query — score by that extension instead of `.php`. The
    // query name may preserve original case, so normalize before matching.
    if !is_recognizable_download_extension(&ext) {
        if let Some(name) = file_name_from_query(url) {
            ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        }
    }
    let ext_win = matches!(
        ext.as_str(),
        "exe" | "msi" | "msix" | "bat" | "cmd" | "zip" | "7z" | "rar"
    );
    let ext_mac = matches!(ext.as_str(), "dmg" | "pkg" | "zip");
    let ext_linux = matches!(
        ext.as_str(),
        "deb" | "rpm" | "appimage" | "tar" | "gz" | "xz" | "zst" | "flatpak" | "snap"
    );
    let mut score: i64 = 0;
    if win && ext_win {
        score += 10;
    }
    if mac && ext_mac {
        score += 10;
    }
    if linux && ext_linux {
        score += 10;
    }
    if x64 && (u.contains("x64") || u.contains("amd64") || u.contains("x86_64")) {
        score += 5;
    }
    if arm64 && (u.contains("arm64") || u.contains("aarch64")) {
        score += 5;
    }
    if matches!(
        ext.as_str(),
        "exe" | "msi" | "msix" | "dmg" | "pkg" | "deb" | "rpm" | "appimage"
    ) {
        score += 2;
    }
    // Page furniture (logos, fonts, subtitle files, thumbnails) maps to
    // category "other". On interstitial pages with no platform hints they
    // would otherwise tie on score and win by DOM order, causing a `logo.png`
    // to be downloaded as the "target file". Give the unambiguous payload
    // categories — installers/archives (program, compressed), video, audio —
    // a floor above "other" so a real file always outranks a stray image.
    //
    // Documents are deliberately EXCLUDED from the floor: a `.txt`/`.md`/`.csv`
    // companion is as likely to be page furniture (README, license, notes) as
    // the target, and on image/font/subtitle target pages (wallpapers, media
    // grabbers) giving documents +3 would let the text companion outrank the
    // actual `.jpg`/`.ttf` the user came for. Those pages resolve by DOM order
    // (all score 0), which is correct for a media grabber. Known boundary: a
    // PDF-manual page whose header logo.png precedes the PDF in DOM order can
    // pick the logo on a score-0 tie — accepted in exchange for never letting
    // a text companion outrank an image/font/subtitle target.
    if matches!(
        crate::daemon::utils::file_type_from_extension(&ext),
        "program" | "compressed" | "video" | "audio"
    ) {
        score += 3;
    }
    if u.contains("setup") || u.contains("installer") || u.contains("install") {
        score += 2;
    }
    score
}

/// Validate that a proxy URL does not target internal/private networks (SSRF).
/// Blocks localhost, loopback, private ranges, link-local, and multicast.
pub fn validate_proxy_url(proxy_url: &str) -> Result<(), String> {
    let url = proxy_url.trim();
    if url.is_empty() {
        return Err("Proxy URL is empty".to_owned());
    }
    let without_scheme = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("socks4://")
        .trim_start_matches("socks4a://")
        .trim_start_matches("socks5://")
        .trim_start_matches("socks5h://");
    let authority = without_scheme.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return Err("Proxy URL contains userinfo (e.g. user@host)".to_owned());
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() || host == "localhost" {
        return Err("Proxy targets localhost".to_owned());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_internal_ip(ip) && !private_network_allowed() {
            return Err(format!("Proxy targets internal IP {ip}"));
        }
        return Ok(());
    }
    // Resolve hostname and check all resolved addresses
    let allow_private = private_network_allowed();
    let addr_str = format!("{host}:443");
    let addrs = addr_str
        .to_socket_addrs()
        .map_err(|e| format!("Could not resolve proxy host '{host}': {e}"))?;
    for addr in addrs {
        if is_internal_ip(addr.ip()) && !allow_private {
            return Err(format!(
                "Proxy host '{}' resolves to internal IP {}",
                host,
                addr.ip()
            ));
        }
    }
    Ok(())
}

/// Sanitize a file name that originates from an untrusted source (server
/// Content-Disposition header, URL path segment, or user input) so it can
/// never escape its destination directory. Server-controlled names are the
/// classic path-traversal vector: a `Content-Disposition: filename="../../x"`
/// or a URL segment containing `%2F` (decoded to `/`) or `%2E%2E` (decoded to
/// `..`) would otherwise let a remote server write files anywhere the daemon
/// can. Returns a bare file name with no path components, no separators, no
/// traversal, no Windows-reserved names, bounded length, and a safe fallback.
/// Decode only the separator-relevant percent escapes (`%2F` for `/`, `%5C`
/// for `\`, `%2E` for `.`) across a whole path. A remote server can smuggle a
/// path traversal through encoding, so we normalize these before any
/// component parsing. Iterates by UTF-8 char (not byte) so multi-byte names
/// survive intact.
pub fn decode_separator_escapes(raw: &str) -> String {
    let mut decoded = String::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let b = raw.as_bytes()[i];
        if b == b'%' && i + 2 < raw.len() {
            if let Ok(v) = u8::from_str_radix(&raw[i + 1..i + 3], 16) {
                if matches!(v, b'/' | b'\\' | b'.') {
                    decoded.push(v as char);
                    i += 3;
                    continue;
                }
            }
        }
        let ch = raw[i..].chars().next().unwrap_or('\u{FFFD}');
        decoded.push(ch);
        i += ch.len_utf8();
    }
    decoded
}

pub fn sanitize_derived_file_name(raw: &str) -> String {
    // Defense in depth: some upstream paths pass the name percent-encoded
    // (e.g. `%2F` for `/`, `%5C` for `\`, `%2E%2E` for `..`). Decode only
    // the separator-relevant escapes so a remote server cannot smuggle a
    // traversal through encoding, regardless of which decoder ran before.
    let decoded = decode_separator_escapes(raw);
    // Strip any directory components — never trust path separators from the
    // source. This neutralizes both `/` and `\` and any `..`/`.` traversal.
    let base = decoded.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() {
        return "download".to_owned();
    }
    // Normalize away lookalike separators (fullwidth slash, division slash)
    // and reject control characters, then re-check for traversal that the
    // NFC normalization may have introduced (e.g. composed `..` sequences).
    let mut sanitized = String::with_capacity(base.len());
    for ch in base.chars() {
        let mapped = match ch {
            '\u{2215}' | '\u{FF0F}' | '\u{2044}' => '_', // ⁄, ／, ⁄
            c if c.is_control() || c == '/' || c == '\\' => '_',
            c => c,
        };
        sanitized.push(mapped);
    }
    // Trim trailing dots/spaces only — leading dots are meaningful for
    // dotfiles (`.gitignore`, `.env`) and must be preserved. A bare `.`/`..`
    // (or any all-dots name) is rejected below as a traversal vector.
    let sanitized = sanitized.trim_end().trim_end_matches(['.', ' ']);
    if sanitized.is_empty()
        || sanitized == "."
        || sanitized == ".."
        || sanitized.chars().all(|c| c == '.')
    {
        return "download".to_owned();
    }
    // Windows reserves device names with ANY extension (CON.txt, NUL.exe,
    // PRN, AUX, COM1-9, LPT1-9). Writing such a name fails with
    // ERROR_INVALID_NAME, so reject them up front instead of failing the
    // download at write time.
    if is_windows_reserved_device_name(sanitized.trim()) {
        return "download".to_owned();
    }
    // Bound the length: 240 chars keeps room for the directory and Windows
    // MAX_PATH considerations while remaining human-readable.
    sanitized.chars().take(240).collect()
}

/// True when `name` (a bare file name, no separators) is a Windows-reserved
/// device name. The base name (before the first dot) is compared
/// case-insensitively against CON/PRN/AUX/NUL/COM1-9/LPT1-9, which Windows
/// reserves with any extension.
fn is_windows_reserved_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim();
    if stem.is_empty() {
        return false;
    }
    let upper = stem.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// Sanitize an output path so that no component can escape the directory the
/// caller chose. The user-picked directory is preserved, but `.`/`..`
/// components are neutralized and the final file-name component — which may be
/// derived from an untrusted server name — is forced to be a bare safe name.
pub fn sanitize_output_path(output: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    // Decode separator escapes across the WHOLE path first — not just the
    // file-name component — so percent-encoded traversal in directory
    // components (`..%2F..%2F`) is recognized and dropped, not left as a
    // literal directory name that survives on disk.
    let decoded = decode_separator_escapes(&output.to_string_lossy());
    let decoded_path = std::path::Path::new(&decoded);
    let safe_name = decoded_path
        .file_name()
        .map(|f| sanitize_derived_file_name(&f.to_string_lossy()))
        .unwrap_or_else(|| "download".to_owned());
    // Rebuild only the directory portion (parent), dropping CurDir/ParentDir
    // so a server-controlled name cannot push the write target outside the
    // chosen folder. The raw file-name component is intentionally excluded
    // from the rebuild and replaced by `safe_name` below.
    let mut dir = std::path::PathBuf::new();
    if let Some(parent) = decoded_path.parent() {
        for comp in parent.components() {
            match comp {
                Component::CurDir | Component::ParentDir => {}
                other => dir.push(other),
            }
        }
    }
    if dir.as_os_str().is_empty() {
        std::path::PathBuf::from(safe_name)
    } else {
        dir.join(safe_name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── sanitize_derived_file_name ────────────────────────────────────────

    #[test]
    fn derived_name_strips_path_traversal() {
        // Classic `..` traversal via Content-Disposition.
        assert_eq!(sanitize_derived_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_derived_file_name("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_derived_file_name("a/../../b/c.exe"), "c.exe");
    }

    #[test]
    fn derived_name_neutralizes_percent_encoded_separators() {
        // A URL path segment may already be percent-decoded by the time the
        // name is derived; `%2F` -> `/` and `%2E%2E` -> `..` must not survive.
        assert_eq!(sanitize_derived_file_name("..%2F..%2Fwin.exe"), "win.exe");
        assert_eq!(sanitize_derived_file_name("..%5C..%5Csys.dll"), "sys.dll");
    }

    #[test]
    fn derived_name_keeps_plain_names_and_dots() {
        assert_eq!(sanitize_derived_file_name("photo.png"), "photo.png");
        assert_eq!(
            sanitize_derived_file_name("archive.tar.gz"),
            "archive.tar.gz"
        );
        assert_eq!(
            sanitize_derived_file_name("  spaced file.zip "),
            "spaced file.zip"
        );
    }

    #[test]
    fn derived_name_falls_back_on_empty_or_dot() {
        assert_eq!(sanitize_derived_file_name(""), "download");
        assert_eq!(sanitize_derived_file_name("   "), "download");
        assert_eq!(sanitize_derived_file_name("..."), "download");
        assert_eq!(sanitize_derived_file_name("CON"), "download");
    }

    #[test]
    fn derived_name_rejects_windows_reserved_devices_with_extension() {
        // Windows reserves device names with ANY extension; writing them
        // fails at the filesystem layer, so the sanitizer must reject them.
        assert_eq!(sanitize_derived_file_name("CON.txt"), "download");
        assert_eq!(sanitize_derived_file_name("nul.exe"), "download");
        assert_eq!(sanitize_derived_file_name("PRN"), "download");
        assert_eq!(sanitize_derived_file_name("com1.zip"), "download");
        assert_eq!(sanitize_derived_file_name("LPT9.bin"), "download");
        // Plain names that merely contain the letters are fine.
        assert_eq!(sanitize_derived_file_name("constant.exe"), "constant.exe");
        assert_eq!(sanitize_derived_file_name("conman.pdf"), "conman.pdf");
    }

    #[test]
    fn derived_name_keeps_leading_dot_dotfiles() {
        // Leading dots are meaningful for dotfiles; only empty/dot-only
        // names fall back to "download".
        assert_eq!(sanitize_derived_file_name(".gitignore"), ".gitignore");
        assert_eq!(sanitize_derived_file_name(".env"), ".env");
    }

    #[test]
    fn derived_name_replaces_control_and_lookalike_separators() {
        assert_eq!(sanitize_derived_file_name("a\u{0000}b.exe"), "a_b.exe");
        assert_eq!(sanitize_derived_file_name("a\u{2215}b.exe"), "a_b.exe");
    }

    #[test]
    fn derived_name_bounds_length() {
        let long = "x".repeat(1000);
        assert_eq!(sanitize_derived_file_name(&long).len(), 240);
    }
    #[test]
    fn output_path_neutralizes_traversal_and_sanitizes_name() {
        let out = std::path::Path::new("C:/Downloads/..%2F..%2Fevil.exe");
        let safe = sanitize_output_path(out);
        assert_eq!(safe, std::path::PathBuf::from("C:/Downloads/evil.exe"));

        let plain = std::path::Path::new("C:/Downloads/report.pdf");
        assert_eq!(sanitize_output_path(plain), plain.to_path_buf());

        let bare = std::path::Path::new("../../evil.exe");
        assert_eq!(
            sanitize_output_path(bare),
            std::path::PathBuf::from("evil.exe")
        );

        // Reserved device name in the file component is neutralized too.
        let reserved = std::path::Path::new("C:/Downloads/NUL.exe");
        assert_eq!(
            sanitize_output_path(reserved),
            std::path::PathBuf::from("C:/Downloads/download")
        );
    }

    // ── is_safe_target_url ────────────────────────────────────────────────

    #[test]
    fn private_network_flag_parsing() {
        assert!(parse_private_network_flag(Some("1")));
        assert!(parse_private_network_flag(Some("true")));
        assert!(parse_private_network_flag(Some("TRUE")));
        assert!(!parse_private_network_flag(Some("0")));
        assert!(!parse_private_network_flag(Some("false")));
        assert!(!parse_private_network_flag(Some("")));
        assert!(!parse_private_network_flag(None));
    }

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

    // ── is_safe_target_url_pinned / is_safe_resolve_entry (IPv6) ─────────

    #[test]
    fn pinned_entry_brackets_ipv6_literals() {
        // curl's `--resolve HOST:PORT:ADDRESS` requires IPv6 addresses to be
        // enclosed in brackets. A bare `host:443:2001:41d0:...` is read as
        // four colon-delimited fields and rejected — the exact failure that
        // broke downloads to IPv6-first hosts (proof.ovh.net, etc.).
        // The host is also a bracketed IPv6 literal here, so the pinned
        // entry must bracket BOTH the host and the address.
        let (_ip, entry) =
            is_safe_target_url_pinned("https://[2606:2800:220:1:248:1893:25c8:1946]/file.bin")
                .unwrap();
        assert!(
            entry.starts_with("[2606:2800:220:1:248:1893:25c8:1946]:"),
            "expected bracketed IPv6 host, got: {entry}"
        );
        assert!(
            entry.contains(":[2606:2800:220:1:248:1893:25c8:1946]"),
            "expected bracketed IPv6 address, got: {entry}"
        );
        assert!(
            entry.split(']').count() == 3,
            "expected exactly two bracketed groups (host + address), got: {entry}"
        );
    }

    #[test]
    fn resolve_entry_accepts_bare_and_bracketed_ipv6() {
        // The exact format produced for IPv6-first hosts before the fix:
        // `host:443:2001:41d0:242:d300::`. The parser must take everything
        // after the second colon as the address, not split on every colon
        // (which misread the address as just `2001` and failed resolution).
        assert!(is_safe_resolve_entry("proof.ovh.net:443:2001:41d0:242:d300::").is_ok());
        assert!(is_safe_resolve_entry("proof.ovh.net:443:[2001:41d0:242:d300::]").is_ok());
        assert!(is_safe_resolve_entry("example.com:443:8.8.8.8").is_ok());
        // connect-to form: HOST:PORT:CONNECT_HOST:CONNECT_PORT — use an IP
        // literal so the test needs no DNS.
        assert!(is_safe_resolve_entry("example.com:443:9.9.9.9:8443").is_ok());
        // The keep-DNS marker stays safe.
        assert!(is_safe_resolve_entry("example.com:443:+").is_ok());
    }

    #[test]
    fn resolve_entry_rejects_internal_ipv6() {
        // SSRF protection must still apply when the target is an internal
        // IPv6 literal, even with brackets or a mapped form.
        assert!(is_safe_resolve_entry("example.com:443:fd00::1").is_err());
        assert!(is_safe_resolve_entry("example.com:443:[::1]").is_err());
        assert!(is_safe_resolve_entry("example.com:443:[fe80::1]").is_err());
        assert!(is_safe_resolve_entry("example.com:443:127.0.0.1").is_err());
        assert!(is_safe_resolve_entry("example.com:443:10.0.0.5").is_err());
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

    // ── is_recognizable_download_extension ────────────────────────────────

    #[test]
    fn recognizable_extension_is_direct_file() {
        for ext in [
            "exe", "msi", "apk", "dmg", "deb", "rpm", "appimage", "zip", "7z", "rar", "tar", "gz",
            "tgz", "xz", "pdf", "docx", "epub", "mp4", "mkv", "mp3", "flac", "jpg", "png", "gif",
            "svg", "webp", "ttf", "woff2", "srt", "vtt", "dll", "so", "torrent", "nupkg", "vsix",
            "ipa", "flatpak", "snap", "ps1", "whl", "jar", "sqlite3", "pem", "mobi", "azw3",
            "m2ts", "opus", "aiff", "jxl", "heic", "db", "log", "yaml", "yml", "tex", "raw", "psd",
            "p12", "pfx", "m4b", "ac3",
        ] {
            assert!(
                is_recognizable_download_extension(ext),
                "expected {ext:?} to be a recognizable download extension"
            );
        }
    }

    #[test]
    fn every_category_mapped_extension_is_also_recognized() {
        // Invariant: an extension that maps to a real category in
        // file_type_from_extension MUST be recognized as a direct file by
        // is_recognizable_download_extension. Keeps the two lists from
        // drifting (a categorized-but-unrecognized extension would be
        // classified in the UI yet skipped by the fast path and the
        // interstitial extractor).
        for ext in [
            // compressed
            "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz", "lzma",
            "arj", "lzh", "cpio", "iso", "cab", "nupkg", "img", "bin", // program
            "exe", "msi", "msix", "appx", "apk", "ipa", "dmg", "pkg", "appimage", "flatpak",
            "snap", "deb", "rpm", "run", "bat", "cmd", "sh", "ps1", "py", "whl", "egg", "jar",
            "war", "xpi", "crx", "vsix", // document
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt",
            "md", "csv", "tsv", "json", "xml", "tex", "log", "yaml", "yml", "epub", "mobi", "azw3",
            // video
            "mp4", "mkv", "avi", "mov", "flv", "wmv", "webm", "ts", "m2ts", "mts", "m4v", "mpg",
            "mpeg", "3gp", "ogv", "rm", "rmvb", "vob", "f4v", // audio
            "mp3", "flac", "wav", "ogg", "m4a", "aac", "wma", "opus", "aiff", "alac", "m4b", "mid",
            "midi", "amr", "ape", "wv", "ac3", "dts", "ra", "mka",
        ] {
            assert!(
                is_recognizable_download_extension(ext),
                "category-mapped extension {ext:?} must also be recognized"
            );
        }
    }

    #[test]
    fn non_file_extensions_not_recognized() {
        for ext in [
            "html", "htm", "php", "asp", "aspx", "jsp", "cgi", "css", "js", "tsx", "rs", "toml",
            "json5", "", "download",
        ] {
            assert!(
                !is_recognizable_download_extension(ext),
                "expected {ext:?} to NOT be a recognizable download extension"
            );
        }
    }

    // ── file_name_from_query ──────────────────────────────────────────────

    #[test]
    fn query_filename_case_insensitive_and_fragment_stripped() {
        // Uppercase extensions in query values must still match (the helper
        // lowercases before the recognizer check), and a URL fragment after
        // the value must not leak into the extension.
        assert_eq!(
            file_name_from_query("https://cdn.example.com/dl?file=SETUP.EXE"),
            Some("SETUP.EXE".to_owned())
        );
        assert_eq!(
            file_name_from_query("https://cdn.example.com/dl?file=Report.Pdf&x=1"),
            Some("Report.Pdf".to_owned())
        );
        assert_eq!(
            file_name_from_query("https://cdn.example.com/dl?file=foo.zip#section"),
            Some("foo.zip".to_owned())
        );
        // Backslash paths are reduced to the final segment too.
        assert_eq!(
            file_name_from_query("https://cdn.example.com/dl?file=%2F..%2F..%2Fevil.exe"),
            Some("evil.exe".to_owned())
        );
    }

    #[test]
    fn query_filename_recognized() {
        assert_eq!(
            file_name_from_query("https://cdn.example.com/download.php?file=setup.exe&id=7"),
            Some("setup.exe".to_owned())
        );
        assert_eq!(
            file_name_from_query("https://cdn.example.com/get?id=7&filename=report%20final.pdf"),
            Some("report final.pdf".to_owned())
        );
        assert_eq!(
            file_name_from_query("https://cdn.example.com/dl?fname=archive.tar.gz"),
            Some("archive.tar.gz".to_owned())
        );
        assert_eq!(
            file_name_from_query("https://cdn.example.com/download?file=%2Fdir%2Fmovie.mkv"),
            Some("movie.mkv".to_owned())
        );
    }

    #[test]
    fn query_filename_ignored_when_not_a_file() {
        // Page-style params, missing values, and non-file extensions must not
        // produce a download name.
        assert_eq!(
            file_name_from_query("https://site.example.com/page?article=hello&lang=en"),
            None
        );
        assert_eq!(file_name_from_query("https://site.example.com/page"), None);
        assert_eq!(
            file_name_from_query("https://site.example.com/download?file=index.html"),
            None
        );
        assert_eq!(
            file_name_from_query("https://site.example.com/download?file="),
            None
        );
        assert_eq!(
            file_name_from_query("https://site.example.com/download?file=setup"),
            None
        );
        // A non-filename key with a file value is not a download hint.
        assert_eq!(
            file_name_from_query("https://site.example.com/dl?page=setup.exe"),
            None
        );
    }

    // ── extract_direct_download_links query-param & extra-extension support ──

    #[test]
    fn extractor_finds_scripted_query_param_links() {
        // A scripted download endpoint whose path ends in .php but whose query
        // names a real file must be treated as a direct-download candidate.
        let html = r#"<html><body>
            <a href="/download.php?file=app_setup.exe&t=1">Download</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/thanks");
        assert_eq!(links.len(), 1);
        assert_eq!(
            links[0],
            "https://site.example.com/download.php?file=app_setup.exe&t=1"
        );
    }

    #[test]
    fn extractor_finds_new_extension_classes() {
        // Image/font/subtitle/data extensions were previously filtered out
        // because they mapped to category "other"; they must now be followed.
        let html = r#"<html><body>
            <a href="/files/cover.jpg">cover</a>
            <a href="/files/font.ttf">font</a>
            <a href="/files/sub.srt">subs</a>
            <a href="/files/backup.db">db</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/files");
        assert_eq!(links.len(), 4);
        assert!(links.contains(&"https://site.example.com/files/cover.jpg".to_owned()));
        assert!(links.contains(&"https://site.example.com/files/font.ttf".to_owned()));
        assert!(links.contains(&"https://site.example.com/files/sub.srt".to_owned()));
        assert!(links.contains(&"https://site.example.com/files/backup.db".to_owned()));
    }

    #[test]
    fn extractor_skips_page_links_without_file_hints() {
        let html = r#"<html><body>
            <a href="/news/article">article</a>
            <a href="/page.php?id=4">script</a>
            <a href="/index.html">home</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/");
        assert!(links.is_empty());
    }

    #[test]
    fn extractor_ranking_installer_outranks_page_furniture() {
        // Software interstitial: the real installer (program category) must
        // outrank a stray logo.png — the category floor exists for this.
        let html = r#"<html><body>
            <a href="https://site.example.com/logo.png">logo</a>
            <a href="https://site.example.com/app-setup.exe">Download</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/thanks");
        assert_eq!(links[0], "https://site.example.com/app-setup.exe");
    }

    #[test]
    fn extractor_ranking_image_target_beats_document_companion() {
        // Media page: the target is an image (other category). A document
        // companion (readme.txt) must NOT outrank the actual .jpg — documents
        // are excluded from the +3 category floor so DOM order (image first)
        // decides, which is correct for a media grabber.
        let html = r#"<html><body>
            <a href="https://site.example.com/wallpaper.jpg">wallpaper</a>
            <a href="https://site.example.com/readme.txt">readme</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/gallery");
        assert_eq!(links[0], "https://site.example.com/wallpaper.jpg");
    }

    #[test]
    fn extractor_ranking_video_target_beats_logo_and_document() {
        // Video page: the .mp4 (video category, +3 floor) outranks both a
        // logo.png and a description.txt companion regardless of DOM order.
        let html = r#"<html><body>
            <a href="https://site.example.com/logo.png">logo</a>
            <a href="https://site.example.com/description.txt">desc</a>
            <a href="https://site.example.com/clip.mp4">video</a>
        </body></html>"#;
        let links = extract_direct_download_links(html, "https://site.example.com/watch");
        assert_eq!(links[0], "https://site.example.com/clip.mp4");
    }

    // ── build_segments ────────────────────────────────────────────────────

    #[test]
    fn four_connections_split_total_evenly() {
        let segs = build_segments(4, 1000, 0, 0);
        assert_eq!(segs.len(), 4);
        let total: u64 = segs.iter().map(|s| s.total_bytes).sum();
        assert_eq!(total, 1000);
    }

    #[test]
    fn last_segment_picks_up_remainder() {
        let segs = build_segments(4, 1000, 0, 0);
        assert_eq!(segs[3].total_bytes, 250);
    }

    #[test]
    fn single_connection_covers_entire_range() {
        let segs = build_segments(1, 5000, 0, 0);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].total_bytes, 5000);
        assert!((segs[0].progress - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn zero_total_returns_single_segment() {
        let segs = build_segments(4, 0, 0, 1024);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].total_bytes, 0);
        assert_eq!(segs[0].downloaded_bytes, 0);
        assert_eq!(segs[0].speed, 1024);
    }

    #[test]
    fn progress_calculated_correctly() {
        let segs = build_segments(2, 1000, 600, 200);
        assert_eq!(segs.len(), 2);
        assert!((segs[0].progress - 1.0).abs() < f64::EPSILON);
        assert_eq!(segs[0].downloaded_bytes, 500);
        assert!((segs[1].progress - 0.2).abs() < f64::EPSILON);
        assert_eq!(segs[1].downloaded_bytes, 100);
    }

    #[test]
    fn downloaded_beyond_seg_clamps() {
        let segs = build_segments(2, 1000, 9999, 0);
        for seg in &segs {
            assert!(seg.downloaded_bytes <= seg.total_bytes);
        }
    }

    #[test]
    fn segment_ids_are_sequential() {
        let segs = build_segments(8, 8000, 0, 0);
        for (i, seg) in segs.iter().enumerate() {
            assert_eq!(seg.id, i as u32);
        }
    }

    #[test]
    fn speed_distributed_evenly() {
        let segs = build_segments(4, 4000, 0, 1000);
        for seg in &segs {
            assert_eq!(seg.speed, 250);
        }
    }

    #[test]
    fn uneven_split_remainder_goes_to_last() {
        let segs = build_segments(3, 1000, 0, 0);
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

    #[test]
    fn meta_refresh_percent_encoded_url() {
        // Some sites percent-encode the ENTIRE URL in the content attribute
        // (`URL='http%3A%2F%2Fhost%2Ffile.zip'`). The parser must decode it so
        // `refreshed_url` recognizes the `http://` prefix instead of treating
        // the encoded string as a relative path.
        let html = r#"<meta http-equiv="refresh" content="0; URL='http%3A%2F%2Fmirror.example.com%2Ffiles%2Fapp.zip'">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("http://mirror.example.com/files/app.zip".to_string())
        );
    }

    #[test]
    fn meta_refresh_percent_encoded_then_entities() {
        // Percent escapes AND HTML entities may both be present
        // (`&amp;` inside an encoded query).
        let html = r#"<meta http-equiv="refresh" content="0;URL=https%3A%2F%2Fx.com%2Fdl%3Ffile%3Da%26b.zip">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("https://x.com/dl?file=a&b.zip".to_string())
        );
    }

    #[test]
    fn meta_refresh_partially_encoded_url_left_intact() {
        // A target that already has a literal scheme (`https://...`) may still
        // percent-encode individual path characters (`%20` for a space). Those
        // must be preserved for the HTTP layer, NOT decoded into a raw space.
        let html =
            r#"<meta http-equiv="refresh" content="0;URL='https://x.com/dl/file%20name.zip'">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("https://x.com/dl/file%20name.zip".to_string())
        );
    }

    #[test]
    fn meta_refresh_encoded_scheme_uppercase() {
        // Encoded-scheme detection must be case-insensitive
        // (`HTTP%3A%2F%2F` vs `http%3a%2f%2f`).
        let html =
            r#"<meta http-equiv="refresh" content="0;URL=HTTPS%3A%2F%2Fcdn.example.com%2Fa.zip">"#;
        assert_eq!(
            parse_meta_refresh_url(html),
            Some("https://cdn.example.com/a.zip".to_string())
        );
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
    fn refreshed_url_leading_slash_is_host_rooted() {
        assert_eq!(
            refreshed_url("/file.zip".into(), "https://example.com/dl/page"),
            "https://example.com/file.zip"
        );
    }

    #[test]
    fn refreshed_url_resolves_parent_directory_query_and_fragment_references() {
        let page = "https://example.com/dl/releases/page.html?old=1";
        assert_eq!(
            refreshed_url("../files/app.zip".into(), page),
            "https://example.com/dl/files/app.zip"
        );
        assert_eq!(
            refreshed_url("?token=next".into(), page),
            "https://example.com/dl/releases/page.html?token=next"
        );
        assert_eq!(
            refreshed_url("#download".into(), page),
            "https://example.com/dl/releases/page.html?old=1#download"
        );
    }

    // ── extract_direct_download_links ─────────────────────────────────────

    #[test]
    fn direct_links_rank_platform_match_first() {
        // Sublime "thank you" page for win-x64: the setup.exe must be chosen
        // over the mac zip / linux deb / signature files.
        let html = r#"<html><body>
            <a href="https://download.sublimetext.com/sublime_text_build_4200_x64_setup.exe">Windows setup</a>
            <a href="https://download.sublimetext.com/sublime_text_build_4200_x64.zip">Windows zip</a>
            <a href="https://download.sublimetext.com/sublime_text_build_4200_mac.zip">macOS zip</a>
            <a href="https://download.sublimetext.com/sublime-text_build-4200_amd64.deb">Linux deb</a>
            <a href="https://download.sublimetext.com/sublimehq-pub.gpg">GPG key</a>
            <a href="/download">More</a>
        </body></html>"#;
        let links = extract_direct_download_links(
            html,
            "https://www.sublimetext.com/download_thanks?target=win-x64#direct-downloads",
        );
        assert!(
            !links.is_empty(),
            "expected at least one file link, got {:?}",
            links
        );
        assert_eq!(
            links[0],
            "https://download.sublimetext.com/sublime_text_build_4200_x64_setup.exe"
        );
        // Signature / navigation links must be excluded.
        assert!(!links.iter().any(|l| l.contains(".gpg")));
        assert!(!links.iter().any(|l| l.ends_with("/download")));
    }

    #[test]
    fn direct_links_resolve_relative_urls() {
        let html = r#"<a href="files/app-1.2.3.zip">zip</a>"#;
        let links = extract_direct_download_links(html, "https://example.com/dl/page");
        assert_eq!(links, vec!["https://example.com/dl/files/app-1.2.3.zip"]);
    }

    #[test]
    fn direct_links_single_quoted_href() {
        let html = r#"<a href='/dl/app_setup.exe'>Download</a>"#;
        let links = extract_direct_download_links(html, "https://mirror.example.com/thanks");
        assert_eq!(links, vec!["https://mirror.example.com/dl/app_setup.exe"]);
    }

    #[test]
    fn direct_links_skip_anchors_and_non_files() {
        let html = r##"<a href="#top">top</a> <a href="mailto:x@y.z">mail</a> <a href="https://x.example.com/">home</a>"##;
        let links = extract_direct_download_links(html, "https://x.example.com/page");
        assert!(links.is_empty());
    }

    #[test]
    fn direct_links_linux_target_picks_linux_file() {
        let html = r#"<html>
            <a href="https://dl.example.com/app-1.0-x86_64.AppImage">AppImage</a>
            <a href="https://dl.example.com/app-1.0_amd64.deb">deb</a>
            <a href="https://dl.example.com/app-1.0-mac.dmg">dmg</a>
        </html>"#;
        let links =
            extract_direct_download_links(html, "https://example.com/download?target=linux-x64");
        // Both AppImage and deb are Linux-family; the mac dmg must rank last.
        assert!(
            links
                .iter()
                .any(|l| l.ends_with(".deb") || l.ends_with(".AppImage")),
            "expected a linux file first, got {:?}",
            links
        );
        assert!(
            links
                .iter()
                .position(|l| l.contains("-mac.dmg"))
                .unwrap_or(usize::MAX)
                > links
                    .iter()
                    .position(|l| l.ends_with(".deb") || l.ends_with(".AppImage"))
                    .unwrap_or(usize::MAX),
            "mac dmg outranked linux files: {:?}",
            links
        );
    }

    #[test]
    fn direct_links_sourceforge_download_suffix_recognized() {
        // SourceForge-style anchors end in a trailing `/download` segment with
        // no extension of its own; the real file name precedes it. These must
        // be extracted (and ranked) instead of filtered out as "other".
        let html = r#"<html>
            <a href="https://sourceforge.net/projects/demo/files/setup/1.0/demo_1.0_win64.exe/download?use_mirror=autoselect">Direct link</a>
            <a href="/projects/demo/files/setup/1.0/demo_1.0_mac.dmg/download">mac</a>
            <a href="https://sourceforge.net/projects/demo">project home</a>
        </html>"#;
        let links = extract_direct_download_links(
            html,
            "https://sourceforge.net/projects/demo/files/setup/1.0/?target=win-x64",
        );
        // The win64 exe (with query string intact) must be extracted first.
        assert!(
            links
                .first()
                .is_some_and(|l| l.contains("demo_1.0_win64.exe/download")),
            "expected sourceforge /download exe first, got {:?}",
            links
        );
        // The mac dmg is present but outranked; the project home page is not a
        // file and must be excluded entirely.
        assert!(
            links.iter().any(|l| l.contains("_mac.dmg")),
            "mac dmg should be present: {:?}",
            links
        );
        assert!(
            !links
                .iter()
                .any(|l| l == "https://sourceforge.net/projects/demo"),
            "project home leaked into candidates: {:?}",
            links
        );
    }

    #[test]
    fn direct_links_github_release_host_rooted_anchors() {
        // GitHub release pages use host-rooted relative anchors
        // (`/owner/repo/releases/download/...`). They must resolve against the
        // page host and be extracted with the real file name.
        let html = r#"<html>
            <a href="/owner/repo/releases/download/v1.2.3/app-1.2.3-win-x64.exe">exe</a>
            <a href="/owner/repo/releases/download/v1.2.3/app-1.2.3-mac.dmg">dmg</a>
            <a href="/owner/repo/releases/tag/v1.2.3">release notes</a>
        </html>"#;
        let links = extract_direct_download_links(
            html,
            "https://github.com/owner/repo/releases/tag/v1.2.3",
        );
        assert!(
            links.first().is_some_and(|l| l
                == "https://github.com/owner/repo/releases/download/v1.2.3/app-1.2.3-win-x64.exe"),
            "expected host-rooted win exe resolved first, got {:?}",
            links
        );
        assert!(
            links
                .iter()
                .any(|l| l.ends_with("/releases/download/v1.2.3/app-1.2.3-mac.dmg")),
            "dmg missing: {:?}",
            links
        );
    }

    #[test]
    fn direct_links_trailing_download_without_extension_still_skipped() {
        // A bare `/download` anchor with no file name (e.g. SourceForge's
        // generic "latest" button) has no recognizable extension and must be
        // skipped even after the suffix is stripped.
        let html =
            r#"<a href="https://sourceforge.net/projects/demo/files/latest/download">latest</a>"#;
        let links = extract_direct_download_links(html, "https://sourceforge.net/projects/demo/");
        assert!(links.is_empty(), "expected no candidates, got {:?}", links);
    }
}
