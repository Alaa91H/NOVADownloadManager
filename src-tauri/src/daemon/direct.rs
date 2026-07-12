use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::raw::{c_char, c_int, c_uint, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::time::Duration;

use serde_json::Value;

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
            Err("Could not allocate libcurl URL handle".to_string())
        } else {
            Ok(Self { raw })
        }
    }

    fn set_url(&self, value: &str) -> Result<(), String> {
        let value = CString::new(value)
            .map_err(|_| "Invalid direct download URL: contains NUL byte".to_string())?;
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
        format!("libcurl URL error {}", code)
    } else {
        unsafe { CStr::from_ptr(message) }
            .to_string_lossy()
            .to_string()
    }
}

fn option_u64(options: &HashMap<String, Value>, key: &str) -> Option<u64> {
    options.get(key).and_then(|value| {
        value
            .as_u64()
            .or_else(|| value.as_str()?.trim().parse().ok())
    })
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
            return Err("Missing url".to_string());
        }
        if value.starts_with('-') {
            return Err("Invalid url: must not start with '-'".to_string());
        }
        let parsed = CurlUrlHandle::new()?;
        parsed.set_url(value)?;
        let normalized = parsed
            .get_part(CURLUPART_URL, 0)?
            .ok_or_else(|| "Invalid direct download URL: missing URL".to_string())?;
        let scheme = parsed
            .get_part(CURLUPART_SCHEME, 0)?
            .ok_or_else(|| "Invalid direct download URL: missing scheme".to_string())?
            .to_ascii_lowercase();
        if !matches!(
            scheme.as_str(),
            "http" | "https" | "ftp" | "ftps" | "sftp" | "scp"
        ) {
            return Err(format!(
                "Unsupported direct download protocol '{}'. Use HTTP, HTTPS, FTP, FTPS, SFTP, or SCP.",
                scheme
            ));
        }
        let host = parsed.get_part(CURLUPART_HOST, 0)?;
        if matches!(
            scheme.as_str(),
            "http" | "https" | "ftp" | "ftps" | "sftp" | "scp"
        ) && host.is_none()
        {
            return Err("Direct download URL must include a host.".to_string());
        }
        let port = parsed
            .get_part(CURLUPART_PORT, CURLU_DEFAULT_PORT)?
            .and_then(|value| value.parse::<u16>().ok());
        let path = parsed
            .get_part(CURLUPART_PATH, 0)?
            .unwrap_or_else(|| "/".to_string());
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
    pub fn len(&self) -> u64 {
        self.end.saturating_sub(self.start).saturating_add(1)
    }
}

#[derive(Clone, Debug)]
pub struct SegmentPlanner {
    max_connections: u32,
}

impl SegmentPlanner {
    pub fn new(max_connections: u32) -> Self {
        Self {
            max_connections: max_connections.max(1),
        }
    }

    pub fn plan(&self, total_size: u64, connections: u32, output_path: &Path) -> Vec<SegmentRange> {
        let count = connections
            .max(1)
            .min(self.max_connections)
            .min(total_size.max(1) as u32) as usize;
        let base = total_size / count as u64;
        let rem = total_size % count as u64;
        let file_base = output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
            .to_string();
        let dir = output_path.parent().unwrap_or_else(|| Path::new(""));
        let mut ranges = Vec::with_capacity(count);
        let mut start = 0u64;
        for index in 0..count {
            let extra = if index < rem as usize { 1 } else { 0 };
            let len = base + extra;
            let end = start.saturating_add(len).saturating_sub(1);
            ranges.push(SegmentRange {
                index,
                start,
                end,
                path: dir.join(format!("{}.part{:03}", file_base, index)),
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

    pub fn current_size(path: &Path) -> u64 {
        std::fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
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
                if name.starts_with(&format!("{}.part", file_name)) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
    }

    pub fn merge_parts(output_path: &Path, ranges: &[SegmentRange]) -> Result<u64, String> {
        let tmp_path = output_path.with_extension("nova-merge-tmp");
        let _ = std::fs::remove_file(&tmp_path);
        let mut out = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("Could not create merge file: {e}"))?;
        let mut total = 0u64;
        for range in ranges {
            let expected = range.len();
            let actual = Self::current_size(&range.path);
            if actual != expected {
                return Err(format!(
                    "Segment {} is incomplete: expected {} bytes, got {} bytes",
                    range.index, expected, actual
                ));
            }
            let mut input = File::open(&range.path)
                .map_err(|e| format!("Could not read segment {}: {e}", range.index))?;
            let copied = std::io::copy(&mut input, &mut out)
                .map_err(|e| format!("Could not merge segment {}: {e}", range.index))?;
            total += copied;
        }
        out.flush()
            .map_err(|e| format!("Could not flush merged file: {e}"))?;
        out.sync_all()
            .map_err(|e| format!("Could not fsync merged file: {e}"))?;
        drop(out);
        let _ = std::fs::remove_file(output_path);
        std::fs::rename(&tmp_path, output_path)
            .map_err(|e| format!("Could not finalize merged file: {e}"))?;
        if let Some(parent) = output_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            if let Ok(dir) = File::open(parent) {
                let _ = dir.sync_all();
            }
        }
        let final_size = Self::current_size(output_path);
        if final_size != total {
            return Err(format!(
                "Merged file size mismatch: expected {} bytes, got {} bytes",
                total, final_size
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
    pub fn from_options(options: &HashMap<String, Value>) -> Self {
        Self {
            attempts: option_u64(options, "retryCount")
                .unwrap_or(0)
                .saturating_add(1)
                .min(50),
            delay: Duration::from_secs(option_u64(options, "retryDelaySec").unwrap_or(2).min(3600)),
            max_total_time: option_u64(options, "retryMaxTimeSec")
                .filter(|v| *v > 0)
                .map(Duration::from_secs),
            retry_all_errors: options
                .get("retryAllErrors")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            backoff_multiplier: options
                .get("backoffMultiplier")
                .and_then(|v| v.as_f64())
                .unwrap_or(2.0)
                .clamp(1.0, 10.0),
            max_delay: Duration::from_secs(
                option_u64(options, "retryMaxDelaySec")
                    .unwrap_or(120)
                    .min(3600),
            ),
            jitter: options
                .get("retryJitter")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        }
    }

    pub fn delay_for_attempt(&self, attempt: u32) -> Duration {
        if attempt == 0 || self.attempts <= 1 {
            return Duration::ZERO;
        }
        let exp = (attempt.saturating_sub(1)) as f64;
        let base = self.delay.as_secs_f64() * self.backoff_multiplier.powf(exp);
        let capped = base.min(self.max_delay.as_secs_f64());
        if self.jitter {
            let jitter_range = capped * 0.25;
            let jitter = (attempt as u64 * 7919) as f64 % jitter_range;
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
    }

    pub fn is_permanent_error(error: &str) -> bool {
        let lower = error.to_ascii_lowercase();
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

impl ConnectionLimits {
    /// Recommend per-host connection count for known CDNs that misbehave
    /// with many concurrent connections (e.g. Google throttles, SourceForge
    /// mirrors reject, VideoLAN stalls).
    fn recommended_per_host(url: &str) -> Option<usize> {
        let host = url
            .split("://")
            .nth(1)?
            .split('/')
            .next()?
            .to_ascii_lowercase();
        if host.contains("dl.google.com") || host.contains("google.com") {
            Some(4)
        } else if host.contains("sourceforge.net") {
            Some(1)
        } else if host.contains("videolan.org") || host.contains("halifax.rwth-aachen.de") {
            Some(4)
        } else if host.contains("mega.nz") || host.contains("mega.co.nz") {
            Some(1)
        } else {
            None
        }
    }

    pub fn from_options(
        options: &HashMap<String, Value>,
        requested: u32,
        max_connections: u32,
    ) -> Self {
        let requested = requested.max(1).min(max_connections) as usize;
        let max_connections = max_connections.max(1) as usize;
        let total = option_u64(options, "maxTotalConnections")
            .map(|value| value as usize)
            .unwrap_or(requested)
            .clamp(1, max_connections);
        let per_host = option_u64(options, "maxHostConnections")
            .map(|value| value as usize)
            .unwrap_or(requested)
            .clamp(1, total);
        let cache = option_u64(options, "maxConnectionCache")
            .or_else(|| option_u64(options, "maxConnects"))
            .map(|value| value as usize)
            .unwrap_or_else(|| total.saturating_mul(2).max(total))
            .clamp(1, max_connections.saturating_mul(4).max(1));
        Self {
            total,
            per_host,
            cache,
        }
    }

    /// Like `from_options` but applies hostname-aware per-host limits when
    /// the user hasn't explicitly set `maxHostConnections`.
    pub fn from_options_for_url(
        options: &HashMap<String, Value>,
        requested: u32,
        max_connections: u32,
        url: &str,
    ) -> Self {
        let mut limits = Self::from_options(options, requested, max_connections);
        if option_u64(options, "maxHostConnections").is_none() {
            if let Some(recommended) = Self::recommended_per_host(url) {
                limits.per_host = recommended.min(limits.total);
            }
        }
        limits
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventLoopMode {
    WaitPerform,
    MultiSocket,
}

impl EventLoopMode {
    pub fn from_options(options: &HashMap<String, Value>) -> Self {
        match options
            .get("eventLoop")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "wait_perform" | "waitperform" | "wait" | "perform" => Self::WaitPerform,
            _ => Self::MultiSocket,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct IntegrityMetadata {
    pub expected_size: Option<u64>,
}

impl IntegrityMetadata {
    pub fn from_expected_size(size: u64) -> Self {
        Self {
            expected_size: (size > 0).then_some(size),
        }
    }
}

#[derive(Clone, Debug)]
pub struct IntegrityValidator {
    metadata: IntegrityMetadata,
}

impl IntegrityValidator {
    pub fn new(metadata: IntegrityMetadata) -> Self {
        Self { metadata }
    }

    pub fn validate_size(&self, actual: u64) -> Result<(), String> {
        if let Some(expected) = self.metadata.expected_size {
            if actual != expected {
                return Err(format!(
                    "Downloaded file size mismatch: expected {} bytes, got {} bytes",
                    expected, actual
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
    fn event_loop_defaults_to_multi_socket() {
        let options = HashMap::new();
        assert_eq!(
            EventLoopMode::from_options(&options),
            EventLoopMode::MultiSocket
        );

        let mut options = HashMap::new();
        options.insert("eventLoop".to_string(), serde_json::json!("waitPerform"));
        assert_eq!(
            EventLoopMode::from_options(&options),
            EventLoopMode::WaitPerform
        );
    }

    #[test]
    fn connection_limits_separate_active_limits_from_cache_size() {
        let mut options = HashMap::new();
        options.insert("maxTotalConnections".to_string(), serde_json::json!(6));
        options.insert("maxHostConnections".to_string(), serde_json::json!(3));
        options.insert("maxConnectionCache".to_string(), serde_json::json!(20));

        let limits = ConnectionLimits::from_options(&options, 8, 32);

        assert_eq!(limits.total, 6);
        assert_eq!(limits.per_host, 3);
        assert_eq!(limits.cache, 20);
    }

    #[test]
    fn max_connects_alias_only_sets_connection_cache() {
        let mut options = HashMap::new();
        options.insert("maxConnects".to_string(), serde_json::json!(4));

        let limits = ConnectionLimits::from_options(&options, 12, 32);

        assert_eq!(limits.total, 12);
        assert_eq!(limits.per_host, 12);
        assert_eq!(limits.cache, 4);
    }
}
