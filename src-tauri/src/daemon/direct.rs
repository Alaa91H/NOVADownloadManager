use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::raw::{c_char, c_int, c_uint, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::Duration;

use crate::daemon::engine::config::{MAX_CONNECTIONS_PER_DOWNLOAD, MIN_CONNECTIONS_PER_DOWNLOAD};

enum CurlUrl {}

type CurlUrlCode = c_int;
type CurlUrlPart = c_int;

const CURLUE_OK: CurlUrlCode = 0;
const CURLUE_NO_HOST: CurlUrlCode = 14;
const CURLUE_NO_PORT: CurlUrlCode = 15;
const CURLUPART_URL: CurlUrlPart = 0;
const CURLUPART_SCHEME: CurlUrlPart = 1;
const CURLUPART_HOST: CurlUrlPart = 5;
const CURLUPART_PORT: CurlUrlPart = 6;
const CURLUPART_PATH: CurlUrlPart = 7;
const CURLU_DEFAULT_PORT: c_uint = 1 << 0;

extern "C" {
    fn curl_url() -> *mut CurlUrl;
    fn curl_url_cleanup(url: *mut CurlUrl);
    fn curl_url_get(
        url: *const CurlUrl,
        part: CurlUrlPart,
        value: *mut *mut c_char,
        flags: c_uint,
    ) -> CurlUrlCode;
    fn curl_url_set(
        url: *mut CurlUrl,
        part: CurlUrlPart,
        value: *const c_char,
        flags: c_uint,
    ) -> CurlUrlCode;
    fn curl_url_strerror(code: CurlUrlCode) -> *const c_char;
    fn curl_free(value: *mut c_void);
}

struct CurlUrlHandle {
    raw: *mut CurlUrl,
}

/// RAII guard that calls `curl_free` on the wrapped pointer when dropped.
struct CurlFreeGuard(*mut c_char);

impl Drop for CurlFreeGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { curl_free(self.0.cast::<c_void>()) }
        }
    }
}

impl CurlUrlHandle {
    fn new() -> Result<Self, String> {
        ::curl::init();
        let raw = unsafe { curl_url() };
        if raw.is_null() {
            Err("Could not allocate libcurl URL handle".to_owned())
        } else {
            Ok(Self { raw })
        }
    }

    fn set_url(&self, value: &str) -> Result<(), String> {
        let value = CString::new(value)
            .map_err(|_| "Invalid direct download URL: contains NUL byte".to_owned())?;
        let code = unsafe { curl_url_set(self.raw, CURLUPART_URL, value.as_ptr(), 0) };
        if code == CURLUE_OK {
            Ok(())
        } else {
            Err(format!(
                "Invalid direct download URL: {}",
                curl_url_error(code)
            ))
        }
    }

    fn get_part(&self, part: CurlUrlPart, flags: c_uint) -> Result<Option<String>, String> {
        let mut value: *mut c_char = ptr::null_mut();
        let code = unsafe { curl_url_get(self.raw, part, &mut value, flags) };
        if code == CURLUE_NO_HOST || code == CURLUE_NO_PORT {
            return Ok(None);
        }
        if code != CURLUE_OK {
            return Err(format!(
                "Could not read libcurl URL part: {}",
                curl_url_error(code)
            ));
        }
        if value.is_null() {
            return Ok(None);
        }
        let _guard = CurlFreeGuard(value);
        let text = unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .to_string();
        Ok(Some(text))
    }
}

impl Drop for CurlUrlHandle {
    fn drop(&mut self) {
        unsafe {
            curl_url_cleanup(self.raw);
        }
    }
}

fn curl_url_error(code: CurlUrlCode) -> String {
    let message = unsafe { curl_url_strerror(code) };
    if message.is_null() {
        format!("libcurl URL error {code}")
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .to_string()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectUrl {
    pub normalized: String,
    pub scheme: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub path: String,
}

impl DirectUrl {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let value = raw.trim();
        if value.is_empty() {
            return Err("Missing url".to_owned());
        }
        if value.starts_with('-') {
            return Err("Invalid url: must not start with '-'".to_owned());
        }
        let parsed = CurlUrlHandle::new()?;
        parsed.set_url(value)?;
        let normalized = parsed
            .get_part(CURLUPART_URL, 0)?
            .ok_or_else(|| "Invalid direct download URL: missing URL".to_owned())?;
        let scheme = parsed
            .get_part(CURLUPART_SCHEME, 0)?
            .ok_or_else(|| "Invalid direct download URL: missing scheme".to_owned())?
            .to_ascii_lowercase();
        if !matches!(
            scheme.as_str(),
            "http" | "https" | "ftp" | "ftps" | "sftp" | "scp"
        ) {
            return Err(format!(
                "Unsupported direct download protocol '{scheme}'. Use HTTP, HTTPS, FTP, FTPS, SFTP, or SCP."
            ));
        }
        let host = parsed.get_part(CURLUPART_HOST, 0)?;
        if matches!(
            scheme.as_str(),
            "http" | "https" | "ftp" | "ftps" | "sftp" | "scp"
        ) && host.is_none()
        {
            return Err("Direct download URL must include a host.".to_owned());
        }
        let port = parsed
            .get_part(CURLUPART_PORT, CURLU_DEFAULT_PORT)?
            .and_then(|value| value.parse::<u16>().ok());
        let path = parsed
            .get_part(CURLUPART_PATH, 0)?
            .unwrap_or_else(|| "/".to_owned());
        Ok(Self {
            normalized,
            scheme,
            host,
            port,
            path,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentRange {
    pub index: usize,
    pub start: u64,
    pub end: u64,
    pub path: PathBuf,
}

impl SegmentRange {
    pub const fn len(&self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

/// The part-file naming convention shared by the transfer planner, the
/// segmented writers and the adaptive rebuild loop. `output_path` may be
/// `dir/name.ext`; the part file is `dir/name.ext.partNNN` (the original
/// extension is preserved so the part files sort next to the destination and
/// are matched by `remove_stale_parts_for`). Every geometry — the initial
/// plan AND each adaptive rebuild — MUST derive its part paths from this
/// helper, otherwise the rebuild loop writes to differently-named files,
/// losing resume state and leaving orphaned parts behind.
pub fn part_file_path(output_path: &Path, index: u32) -> PathBuf {
    let file_base = output_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .to_owned();
    let dir = output_path.parent().unwrap_or_else(|| Path::new(""));
    dir.join(format!("{file_base}.part{index:03}"))
}

#[derive(Clone, Debug)]
pub struct SegmentPlanner {
    max_connections: u32,
}

impl SegmentPlanner {
    pub fn new(max_connections: u32) -> Self {
        Self {
            max_connections: max_connections
                .clamp(MIN_CONNECTIONS_PER_DOWNLOAD, MAX_CONNECTIONS_PER_DOWNLOAD),
        }
    }

    pub fn plan(&self, total_size: u64, connections: u32, output_path: &Path) -> Vec<SegmentRange> {
        // A zero-sized/unknown resource cannot be represented by an inclusive
        // byte range. Without this guard the saturated `end` computation below
        // would fabricate 0..=u64::MAX and spawn a bogus segmented transfer.
        if total_size == 0 {
            return Vec::new();
        }
        let count = connections
            .clamp(MIN_CONNECTIONS_PER_DOWNLOAD, self.max_connections)
            .min(u32::try_from(total_size.max(1)).unwrap_or(self.max_connections))
            as usize;
        let base = total_size / count as u64;
        let rem = total_size % count as u64;
        let mut ranges = Vec::with_capacity(count);
        let mut start = 0u64;
        for index in 0..count {
            let extra = u64::from(index < rem as usize);
            let len = base + extra;
            let end = start.saturating_add(len).saturating_sub(1);
            ranges.push(SegmentRange {
                index,
                start,
                end,
                path: part_file_path(output_path, index as u32),
            });
            start = end.saturating_add(1);
        }
        ranges
    }
}

pub struct FileWriter;

impl FileWriter {
    pub fn ensure_parent(path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Could not create destination folder: {e}"))?;
            }
        }
        Ok(())
    }

    pub fn current_size(path: &Path) -> Result<u64, String> {
        match std::fs::metadata(path) {
            Ok(metadata) => Ok(metadata.len()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(e) => Err(format!(
                "Failed to read file size for {}: {e}",
                path.display()
            )),
        }
    }

    pub fn cleanup_parts(ranges: &[SegmentRange]) {
        for range in ranges {
            let _ = std::fs::remove_file(&range.path);
        }
    }

    pub fn remove_stale_parts_for(output_path: &Path) {
        let Some(parent) = output_path.parent() else {
            return;
        };
        let Some(file_name) = output_path.file_name().and_then(|value| value.to_str()) else {
            return;
        };
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if name.starts_with(&format!("{file_name}.part")) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }

    pub fn merge_parts(output_path: &Path, ranges: &[SegmentRange]) -> Result<u64, String> {
        // Include a random suffix to prevent collisions if two NOVA processes
        // merge the same file concurrently or the same file is re-downloaded.
        let random_suffix: u64 = u64::from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos(),
        ) ^ u64::from(std::process::id()) << 24;
        let tmp_path = output_path.with_extension(format!("nova-merge-tmp-{random_suffix:x}"));
        let _ = std::fs::remove_file(&tmp_path);
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("Could not create merge file: {e}"))?;
        let mut total = 0u64;
        {
            // M-10: 1 MiB buffers on BOTH sides. std::io::copy alone uses an
            // 8 KiB internal buffer, so merging many segments was syscall-bound
            // (one tiny read + write per 8 KiB), slowing finalization of large
            // files. A BufWriter around `out` batches the writes too.
            let mut buffered_out = std::io::BufWriter::with_capacity(1 << 20, &mut out);
            for range in ranges {
                let expected = range.len();
                let actual = Self::current_size(&range.path)?;
                if actual > expected {
                    // A segment may temporarily exceed its logical length after an
                    // adaptive rebalance wrote a prefix beyond the planned end.
                    // Truncate it back to the expected size before merging.
                    log::warn!(
                        "merge_parts: truncating segment {} from {actual} to {expected} bytes",
                        range.index
                    );
                    let file = OpenOptions::new()
                        .write(true)
                        .open(&range.path)
                        .map_err(|e| {
                            format!("Could not open segment {} to truncate: {e}", range.index)
                        })?;
                    file.set_len(expected)
                        .map_err(|e| format!("Could not truncate segment {}: {e}", range.index))?;
                } else if actual < expected {
                    return Err(format!(
                        "Segment {} is incomplete: expected {} bytes, got {} bytes",
                        range.index, expected, actual
                    ));
                }
                let mut input = std::io::BufReader::with_capacity(
                    1 << 20,
                    File::open(&range.path)
                        .map_err(|e| format!("Could not read segment {}: {e}", range.index))?,
                );
                let copied = std::io::copy(&mut input, &mut buffered_out)
                    .map_err(|e| format!("Could not merge segment {}: {e}", range.index))?;
                total += copied;
            }
            buffered_out
                .flush()
                .map_err(|e| format!("Could not flush merged file: {e}"))?;
        }
        out.sync_all()
            .map_err(|e| format!("Could not fsync merged file: {e}"))?;
        drop(out);
        if std::fs::rename(&tmp_path, output_path).is_err() {
            std::fs::remove_file(output_path)
                .map_err(|e| format!("Could not remove file for merge: {e}"))?;
            std::fs::rename(&tmp_path, output_path)
                .map_err(|e| format!("Could not finalize merged file: {e}"))?;
        }
        if let Some(parent) = output_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        let final_size = Self::current_size(output_path)?;
        if final_size != total {
            return Err(format!(
                "Merged file size mismatch: expected {total} bytes, got {final_size} bytes"
            ));
        }
        Self::cleanup_parts(ranges);
        Ok(total)
    }
}

#[derive(Clone, Debug)]
pub struct RetryPolicy {
    pub attempts: u64,
    pub delay: Duration,
    pub max_total_time: Option<Duration>,
    pub retry_all_errors: bool,
    pub backoff_multiplier: f64,
    pub max_delay: Duration,
    pub jitter: bool,
}

impl RetryPolicy {
    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        if attempt == 0 || self.attempts <= 1 {
            return Duration::ZERO;
        }
        let exp = f64::from(attempt.saturating_sub(1));
        let base = self.delay.as_secs_f64() * self.backoff_multiplier.powf(exp);
        let capped = base.min(self.max_delay.as_secs_f64());
        if self.jitter {
            let jitter_range = capped * 0.25;
            // Use time-based entropy for non-deterministic jitter to avoid
            // thundering-herd when multiple tasks retry at the same attempt.
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos();
            let jitter = (f64::from(nanos) / f64::from(u32::MAX)) * jitter_range;
            Duration::from_secs_f64((capped + jitter).max(0.1))
        } else {
            Duration::from_secs_f64(capped)
        }
    }

    pub fn should_retry_error(&self, error: &str) -> bool {
        if self.retry_all_errors {
            return true;
        }
        Self::is_transient_error(error)
    }

    pub fn is_transient_error(error: &str) -> bool {
        let lower = error.to_ascii_lowercase();
        // Permanent SSL/TLS errors that will never succeed on retry.
        let permanent_ssl = lower.contains("certificate verify failed")
            || lower.contains("unable to get local issuer")
            || lower.contains("unable to verify the first certificate")
            || lower.contains("certificate has expired")
            || lower.contains("certificate is not yet valid")
            || lower.contains("hostname mismatch")
            || lower.contains("unsupported certificate")
            || lower.contains("unknown ca")
            || lower.contains("ssl: no alternative");
        if permanent_ssl {
            return false;
        }
        lower.contains("connection refused")
            || lower.contains("connection reset")
            || lower.contains("timed out")
            || lower.contains("temporary failure")
            || lower.contains("try again")
            || lower.contains("eof")
            || lower.contains("broken pipe")
            || lower.contains("network is unreachable")
            || lower.contains("host unreachable")
            || lower.contains("no route to host")
            || lower.contains("operation timed out")
            || lower.contains("ssl")
            || lower.contains("tls")
            || lower.contains("429")
            || lower.contains("416")
            || lower.contains("502")
            || lower.contains("503")
    }

    pub fn is_permanent_error(error: &str) -> bool {
        let lower = error.to_ascii_lowercase();
        // Cloudflare / anti-bot challenges commonly return 403.  Do NOT
        // treat those as permanent – a retry after a short backoff is
        // the correct thing to do.
        if (lower.contains("403") || lower.contains("forbidden"))
            && (lower.contains("cloudflare")
                || lower.contains("challenge")
                || lower.contains("cf-")
                || lower.contains("captcha")
                || lower.contains("bot"))
        {
            return false;
        }
        lower.contains("403")
            || lower.contains("401")
            || lower.contains("404")
            || lower.contains("410")
            || lower.contains("forbidden")
            || lower.contains("unauthorized")
            || lower.contains("not found")
            || lower.contains("gone")
            || lower.contains("invalid url")
            || lower.contains("ssrf blocked")
    }
}

#[derive(Clone, Debug)]
pub struct ConnectionLimits {
    pub total: usize,
    pub per_host: usize,
    pub cache: usize,
}

/// Per-host connection ceilings learned at runtime. When a host stalls or
/// rejects parallel range connections, the engine records a lower ceiling here
/// so later downloads from the same host skip the doomed parallel attempt —
/// adapting to any host without hard-coding domains (AIMD-style decrease).
fn host_conn_ceilings() -> &'static std::sync::Mutex<HashMap<String, usize>> {
    static CEILINGS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, usize>>> =
        std::sync::OnceLock::new();
    CEILINGS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Normalized network-origin key for a direct-download URL.
///
/// This deliberately derives the key from libcurl's parsed host and effective
/// port instead of splitting the original string. Raw splitting could include
/// user info, query text, or fragments in an in-memory scheduling key and
/// treated equivalent origins as different hosts. Keeping the port prevents a
/// learned ceiling for one service on a shared hostname from throttling another.
pub fn host_key(url: &str) -> Option<String> {
    let parsed = DirectUrl::parse(url).ok()?;
    let host = parsed
        .host?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host
    };
    parsed.port.map(|port| format!("{authority}:{port}"))
}

/// The learned per-host connection ceiling, if the host previously misbehaved.
pub fn learned_host_ceiling(url: &str) -> Option<usize> {
    let key = host_key(url)?;
    host_conn_ceilings().lock().ok()?.get(&key).copied()
}

/// Record a per-host connection ceiling (multiplicative decrease). Never raises
/// an existing, lower ceiling.
pub fn record_host_ceiling(url: &str, ceiling: usize) {
    if let Some(key) = host_key(url) {
        if let Ok(mut map) = host_conn_ceilings().lock() {
            let entry = map.entry(key).or_insert(ceiling.max(1));
            *entry = (*entry).min(ceiling.max(1));
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct IntegrityMetadata {
    pub expected_size: Option<u64>,
    /// When true the server used Content-Encoding (gzip/br/deflate), so
    /// libcurl decompressed the body transparently and the on-disk size
    /// will differ from the Content-Length reported size.  Size validation
    /// is skipped in this case.
    pub compressed_transfer: bool,
}

#[derive(Clone, Debug)]
pub struct IntegrityValidator {
    metadata: IntegrityMetadata,
}

impl IntegrityValidator {
    pub const fn new(metadata: IntegrityMetadata) -> Self {
        Self { metadata }
    }

    pub fn validate_size(&self, actual: u64) -> Result<(), String> {
        if self.metadata.compressed_transfer {
            // Size validation is unreliable when the server used
            // Content-Encoding because libcurl decompresses the body
            // transparently — the on-disk size reflects the uncompressed
            // output, not the Content-Length wire value.
            return Ok(());
        }
        if let Some(expected) = self.metadata.expected_size {
            if actual != expected {
                return Err(format!(
                    "Downloaded file size mismatch: expected {expected} bytes, got {actual} bytes"
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_planner_covers_file_contiguously() {
        let ranges = SegmentPlanner::new(32).plan(10, 3, Path::new("file.bin"));
        assert_eq!(ranges.len(), 3);
        assert_eq!(ranges[0].start, 0);
        assert_eq!(ranges.last().unwrap().end, 9);
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
        let total: u64 = ranges.iter().map(SegmentRange::len).sum();
        assert_eq!(total, 10);
    }

    #[test]
    fn direct_url_rejects_non_download_protocols() {
        assert!(DirectUrl::parse("magnet:?xt=urn:btih:abc").is_err());
        assert!(DirectUrl::parse("file:///C:/secret.txt").is_err());
        assert!(DirectUrl::parse("https://example.com/file.iso").is_ok());
        assert!(DirectUrl::parse("sftp://example.com/file.iso").is_ok());
        assert!(DirectUrl::parse("scp://example.com/file.iso").is_ok());
    }

    #[test]
    fn segment_planner_caps_excessive_connection_requests_at_absolute_safety_limit() {
        let total_size = u64::from(MAX_CONNECTIONS_PER_DOWNLOAD) * 1024;
        let ranges = SegmentPlanner::new(u32::MAX).plan(u64::MAX, u32::MAX, Path::new("large.bin"));
        assert_eq!(ranges.len(), MAX_CONNECTIONS_PER_DOWNLOAD as usize);
        assert_eq!(ranges.first().map(|range| range.start), Some(0));
        assert_eq!(ranges.last().map(|range| range.end), Some(u64::MAX - 1));

        let small_ranges =
            SegmentPlanner::new(u32::MAX).plan(total_size, u32::MAX, Path::new("small.bin"));
        assert_eq!(small_ranges.len(), MAX_CONNECTIONS_PER_DOWNLOAD as usize);
        assert_eq!(
            small_ranges.iter().map(SegmentRange::len).sum::<u64>(),
            total_size
        );
    }

    #[test]
    fn segment_planner_returns_no_ranges_for_zero_size() {
        let ranges = SegmentPlanner::new(32).plan(0, 8, Path::new("empty.bin"));
        assert!(ranges.is_empty());
    }

    #[test]
    fn host_key_uses_normalized_origin_without_user_info_or_resource_parts() {
        assert_eq!(
            host_key("HTTPS://user:secret@Example.COM:8443/path/file?token=redacted#part"),
            Some("example.com:8443".to_owned())
        );
        assert_eq!(
            host_key("https://example.com/another/path?another=value"),
            Some("example.com:443".to_owned())
        );
    }

    #[test]
    fn host_key_keeps_ports_and_formats_ipv6_authorities_unambiguously() {
        assert_eq!(
            host_key("https://example.com:9443/file"),
            Some("example.com:9443".to_owned())
        );
        assert_eq!(
            host_key("https://[2001:db8::1]/file"),
            Some("[2001:db8::1]:443".to_owned())
        );
        assert_eq!(host_key("not a direct-download URL"), None);
    }
}
