use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

use ::curl::easy::{Easy2, Handler, HttpVersion, List, WriteError};
use ::curl::multi::{Easy2Handle, Multi};

use crate::daemon::engine_capabilities;
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, CurlJob, Segment, Task};
use crate::daemon::utils::{build_segments, infer_file_type, kill_process, now_str};
use crate::lock_or_err;

const DEFAULT_DIRECT_CONNECTIONS: u32 = 8;
const MAX_DIRECT_CONNECTIONS: u32 = 32;
const MIN_SEGMENT_SIZE: u64 = 1024 * 1024;
const PROGRESS_INTERVAL_MS: u64 = 250;

const ALLOWED_CURL_RAW_OPTIONS: &[&str] = &[
    "--ipv4",
    "--ipv6",
    "--http1.0",
    "--http1.1",
    "--http2",
    "--http2-prior-knowledge",
    "--http3",
    "--http3-only",
    "--compressed",
    "--disable-epsv",
    "--ssl-no-revoke",
    "--tcp-fastopen",
    "--tcp-nodelay",
    "--no-keepalive",
    "--ssl-reqd",
    "--path-as-is",
    "--globoff",
    "--remote-time",
    "--retry-connrefused",
];

#[derive(Clone, Debug)]
struct DirectDownloadPlan {
    url: String,
    output_path: PathBuf,
    total_size: u64,
    connections: u32,
    resumable: bool,
    allow_overwrite: bool,
    follow_redirects: bool,
    fail_on_error: bool,
    segmented: bool,
    remove_on_error: bool,
    referer: Option<String>,
    direct_options: HashMap<String, serde_json::Value>,
}

#[derive(Clone, Debug)]
struct ByteRange {
    index: usize,
    start: u64,
    end: u64,
    path: PathBuf,
}

#[derive(Clone)]
struct SegmentProgress {
    downloaded: Arc<AtomicU64>,
    abort: Arc<AtomicBool>,
}

struct SegmentWriter {
    file: File,
    progress: SegmentProgress,
}

impl Handler for SegmentWriter {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.progress.abort.load(Ordering::Relaxed) {
            return Ok(0);
        }
        match self.file.write_all(data) {
            Ok(()) => {
                self.progress.downloaded.fetch_add(data.len() as u64, Ordering::Relaxed);
                Ok(data.len())
            }
            Err(_) => Ok(0),
        }
    }

    fn progress(&mut self, _dltotal: f64, _dlnow: f64, _ultotal: f64, _ulnow: f64) -> bool {
        !self.progress.abort.load(Ordering::Relaxed)
    }
}

fn direct_str<'a>(direct_options: &'a HashMap<String, serde_json::Value>, key: &str) -> Option<&'a str> {
    direct_options
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

fn direct_bool(direct_options: &HashMap<String, serde_json::Value>, key: &str) -> Option<bool> {
    direct_options.get(key).and_then(|v| v.as_bool())
}

fn direct_u64(direct_options: &HashMap<String, serde_json::Value>, key: &str) -> Option<u64> {
    direct_options
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n.max(0.0) as u64)))
}

fn direct_array(direct_options: &HashMap<String, serde_json::Value>, key: &str) -> Vec<String> {
    direct_options
        .get(key)
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn safe_value(value: &str) -> bool {
    !value.is_empty() && !value.contains(|c: char| c == '\0' || c == '\n' || c == '\r')
}

fn push_optional_arg(args: &mut Vec<String>, flag: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        if !safe_value(value) {
            return Err(format!("Rejected unsafe value for {}", flag));
        }
        push_arg(args, flag, value);
    }
    Ok(())
}

fn push_optional_u64(args: &mut Vec<String>, flag: &str, value: Option<u64>) {
    if let Some(value) = value.filter(|value| *value > 0) {
        push_arg(args, flag, &value.to_string());
    }
}

fn push_bool_flag(args: &mut Vec<String>, enabled: Option<bool>, flag: &str) {
    if enabled == Some(true) {
        args.push(flag.to_string());
    }
}

fn push_array_args(args: &mut Vec<String>, flag: &str, values: Vec<String>) -> Result<(), String> {
    for value in values {
        if !safe_value(&value) {
            return Err(format!("Rejected unsafe value for {}", flag));
        }
        push_arg(args, flag, &value);
    }
    Ok(())
}

fn push_arg(args: &mut Vec<String>, flag: &str, value: &str) {
    args.push(flag.to_string());
    args.push(value.to_string());
}

fn push_header_lines(args: &mut Vec<String>, raw_headers: &str) {
    for line in raw_headers
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.contains(':') {
            push_arg(args, "--header", line);
        }
    }
}

fn apply_raw_curl_options(args: &mut Vec<String>, raw_options: &str) -> Result<(), String> {
    for line in raw_options
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let option = line.split_whitespace().next().unwrap_or("");
        let allowed = ALLOWED_CURL_RAW_OPTIONS
            .iter()
            .any(|allowed| option == *allowed || option.starts_with(&format!("{}=", allowed)));
        let safe = !line.contains(|c: char| c == ';' || c == '|' || c == '&' || c == '$' || c == '`' || c == '\n' || c == '\r');
        if !allowed || !safe {
            return Err(format!("Rejected unsupported curl raw option '{}'", line));
        }
        args.extend(line.split_whitespace().map(str::to_string));
    }
    Ok(())
}

fn requested_connections(connections: Option<u32>) -> u32 {
    match connections.unwrap_or(0) {
        0 => DEFAULT_DIRECT_CONNECTIONS,
        n => n.clamp(1, MAX_DIRECT_CONNECTIONS),
    }
}

fn file_name_from_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("download").trim();
    if name.is_empty() { "download".to_string() } else { name.to_string() }
}

fn destination_from_body(body: &CreateDownloadBody, url: &str) -> (String, PathBuf) {
    let name = body
        .name
        .clone()
        .unwrap_or_else(|| file_name_from_url(url));
    if let Some(save_path) = body.save_path.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        let path = PathBuf::from(save_path);
        return (name, path);
    }
    (name.clone(), PathBuf::from(name))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create destination folder: {e}"))?;
        }
    }
    Ok(())
}

fn current_file_size(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub(crate) fn build_curl_args(body: &CreateDownloadBody, output_path: &Path) -> Result<Vec<String>, String> {
    build_curl_args_with_capabilities(body, output_path, true)
}

fn build_curl_args_with_capabilities(
    body: &CreateDownloadBody,
    output_path: &Path,
    fail_with_body_supported: bool,
) -> Result<Vec<String>, String> {
    let url = body.url.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing url".to_string());
    }
    if url.starts_with('-') {
        return Err("Invalid url: must not start with '-'".to_string());
    }
    if url.starts_with("magnet:") || url.to_lowercase().ends_with(".torrent") || url.contains(".torrent?") {
        return Err("curl/libcurl is the direct-download engine. Magnet and torrent tasks need a separate torrent engine.".to_string());
    }

    let direct_options = body.direct_options.as_ref();
    let follow_redirects = direct_options
        .and_then(|dopts| direct_bool(dopts, "location"))
        .unwrap_or(true);
    let fail_with_body = direct_options
        .and_then(|dopts| direct_bool(dopts, "failWithBody"))
        .unwrap_or(true);
    let resumable = body.resumable.unwrap_or(true);

    let mut args = vec![
        "--show-error".to_string(),
        "--silent".to_string(),
        "--create-dirs".to_string(),
        "--output".to_string(),
        output_path.to_string_lossy().to_string(),
    ];
    if follow_redirects {
        args.push("--location".to_string());
    }
    if fail_with_body && fail_with_body_supported {
        args.push("--fail-with-body".to_string());
    } else {
        args.push("--fail".to_string());
    }

    if resumable {
        args.push("--continue-at".to_string());
        args.push("-".to_string());
    }

    let mut referer_from_direct = None;
    if let Some(dopts) = &body.direct_options {
        push_optional_arg(&mut args, "--proxy", direct_str(dopts, "proxy"))?;
        push_optional_arg(&mut args, "--noproxy", direct_str(dopts, "noproxy"))?;
        push_optional_arg(&mut args, "--interface", direct_str(dopts, "sourceAddress").or_else(|| direct_str(dopts, "interface")))?;
        push_optional_arg(&mut args, "--user-agent", direct_str(dopts, "userAgent"))?;
        if let Some(referer) = direct_str(dopts, "referer") {
            referer_from_direct = Some(referer.to_string());
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitKbs").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &format!("{}K", speed));
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitBytes").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &speed.to_string());
        }
        push_optional_u64(&mut args, "--speed-limit", direct_u64(dopts, "lowSpeedLimitBytes"));
        push_optional_u64(&mut args, "--speed-time", direct_u64(dopts, "speedTimeSec"));
        if let Some(username) = direct_str(dopts, "username") {
            let password = direct_str(dopts, "password").unwrap_or("");
            push_arg(&mut args, "--user", &format!("{}:{}", username, password));
        }
        if let Some(retries) = direct_u64(dopts, "retryCount") {
            push_arg(&mut args, "--retry", &retries.to_string());
        }
        push_optional_u64(&mut args, "--retry-delay", direct_u64(dopts, "retryDelaySec"));
        push_optional_u64(&mut args, "--retry-max-time", direct_u64(dopts, "retryMaxTimeSec"));
        push_optional_u64(&mut args, "--max-time", direct_u64(dopts, "timeoutSec"));
        push_optional_u64(&mut args, "--connect-timeout", direct_u64(dopts, "connectTimeoutSec"));
        push_optional_u64(&mut args, "--max-redirs", direct_u64(dopts, "maxRedirs"));
        push_optional_u64(&mut args, "--max-filesize", direct_u64(dopts, "maxFilesize"));
        push_optional_arg(&mut args, "--range", direct_str(dopts, "range"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "remoteTime"), "--remote-time");
        if direct_bool(dopts, "allowOverwrite") == Some(false) {
            args.push("--no-clobber".to_string());
        }
        if let Some(method) = direct_str(dopts, "requestMethod") {
            push_optional_arg(&mut args, "--request", Some(method))?;
        }
        push_optional_arg(&mut args, "--data-raw", direct_str(dopts, "data"))?;
        push_array_args(&mut args, "--form-string", direct_array(dopts, "form"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "compressed"), "--compressed");
        push_bool_flag(&mut args, direct_bool(dopts, "insecure"), "--insecure");
        push_optional_arg(&mut args, "--cacert", direct_str(dopts, "caCert"))?;
        push_array_args(&mut args, "--resolve", direct_array(dopts, "resolve"))?;
        push_array_args(&mut args, "--connect-to", direct_array(dopts, "connectTo"))?;
        push_bool_flag(&mut args, direct_bool(dopts, "tcpNoDelay"), "--tcp-nodelay");
        push_bool_flag(&mut args, direct_bool(dopts, "pathAsIs"), "--path-as-is");
        push_bool_flag(&mut args, direct_bool(dopts, "globoff"), "--globoff");

        match direct_str(dopts, "httpVersion").unwrap_or("").to_ascii_lowercase().as_str() {
            "1.0" | "http1.0" => args.push("--http1.0".to_string()),
            "1.1" | "http1.1" => args.push("--http1.1".to_string()),
            "2" | "http2" => args.push("--http2".to_string()),
            "2-prior-knowledge" | "http2-prior-knowledge" => args.push("--http2-prior-knowledge".to_string()),
            "3" | "http3" => args.push("--http3".to_string()),
            "3-only" | "http3-only" => args.push("--http3-only".to_string()),
            _ => {}
        }
        let mut headers = Vec::new();
        if let Some(raw_headers) = direct_str(dopts, "headers") {
            push_header_lines(&mut headers, raw_headers);
        }
        if let Some(cookies) = direct_str(dopts, "cookies") {
            push_arg(&mut args, "--cookie", cookies);
        }
        args.extend(headers);
        if let Some(raw_options) = direct_str(dopts, "rawOptions") {
            apply_raw_curl_options(&mut args, raw_options)?;
        }
    }

    if let Some(referer) = referer_from_direct
        .as_deref()
        .or_else(|| body.referer.as_deref().map(str::trim).filter(|v| !v.is_empty()))
    {
        push_arg(&mut args, "--referer", referer);
    }

    args.push(url.to_string());
    Ok(args)
}

fn task_from_body(
    body: &CreateDownloadBody,
    id: &str,
    name: String,
    output_path: &Path,
    args: Vec<String>,
    direct_options: HashMap<String, serde_json::Value>,
) -> CurlJob {
    let category = body
        .category
        .clone()
        .unwrap_or_else(|| infer_file_type(&name).to_string());
    let file_type = body
        .file_type
        .clone()
        .unwrap_or_else(|| infer_file_type(&name).to_string());
    let initial_size = body.size_bytes.unwrap_or(0);
    let downloaded = current_file_size(output_path);
    let task = Task {
        id: id.to_string(),
        name,
        url: body.url.as_deref().unwrap_or("").to_string(),
        file_type,
        status: if body.start_immediately.unwrap_or(true) { "downloading" } else { "queued" }.to_string(),
        size_bytes: initial_size,
        downloaded_bytes: downloaded,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        date_added: now_str(),
        category,
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_string()),
        connections: requested_connections(body.connections),
        resumable: body.resumable.unwrap_or(true),
        save_path: output_path.to_string_lossy().to_string(),
        description: body.description.clone().unwrap_or_else(|| "Direct download via libcurl multi".to_string()),
        segments: build_segments(requested_connections(body.connections), initial_size, downloaded, true, 0),
        referer: body.referer.clone(),
        engine: "libcurl-multi".to_string(),
        engine_id: id.to_string(),
        engine_status: Some(if body.start_immediately.unwrap_or(true) { "starting" } else { "queued" }.to_string()),
        error_message: None,
        torrent_metadata: None,
    };
    CurlJob {
        task,
        child: None,
        args,
        direct_options,
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
    }
}

fn plan_from_job(job: &CurlJob) -> DirectDownloadPlan {
    let opts = job.direct_options.clone();
    let allow_overwrite = direct_bool(&opts, "allowOverwrite").unwrap_or(true);
    let forced_single = direct_bool(&opts, "forceSingleConnection").unwrap_or(false);
    let segmented = direct_bool(&opts, "segmented").unwrap_or(true)
        && !forced_single
        && job.task.resumable
        && job.task.size_bytes >= MIN_SEGMENT_SIZE
        && job.task.connections > 1;
    DirectDownloadPlan {
        url: job.task.url.clone(),
        output_path: PathBuf::from(&job.task.save_path),
        total_size: job.task.size_bytes,
        connections: job.task.connections.clamp(1, MAX_DIRECT_CONNECTIONS),
        resumable: job.task.resumable,
        allow_overwrite,
        follow_redirects: direct_bool(&opts, "location").unwrap_or(true),
        fail_on_error: direct_bool(&opts, "failWithBody").unwrap_or(true),
        segmented,
        remove_on_error: direct_bool(&opts, "removeOnError").unwrap_or(false),
        referer: direct_str(&opts, "referer").map(str::to_string).or_else(|| job.task.referer.clone()),
        direct_options: opts,
    }
}

fn split_ranges(total_size: u64, connections: u32, output_path: &Path) -> Vec<ByteRange> {
    let count = connections.max(1).min(MAX_DIRECT_CONNECTIONS).min(total_size.max(1) as u32) as usize;
    let base = total_size / count as u64;
    let rem = total_size % count as u64;
    let file_base = output_path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("download")
        .to_string();
    let dir = output_path.parent().unwrap_or_else(|| Path::new(""));
    let mut ranges = Vec::with_capacity(count);
    let mut start = 0u64;
    for index in 0..count {
        let extra = if index < rem as usize { 1 } else { 0 };
        let len = base + extra;
        let end = start.saturating_add(len).saturating_sub(1);
        ranges.push(ByteRange {
            index,
            start,
            end,
            path: dir.join(format!("{}.part{:03}", file_base, index)),
        });
        start = end.saturating_add(1);
    }
    ranges
}

fn part_size(range: &ByteRange) -> u64 {
    range.end.saturating_sub(range.start).saturating_add(1)
}

fn cleanup_parts(ranges: &[ByteRange]) {
    for range in ranges {
        let _ = std::fs::remove_file(&range.path);
    }
}

fn remove_stale_parts_for(output_path: &Path) {
    let Some(parent) = output_path.parent() else { return; };
    let Some(file_name) = output_path.file_name().and_then(|v| v.to_str()) else { return; };
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|v| v.to_str()) else { continue; };
            if name.starts_with(&format!("{}.part", file_name)) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn merge_parts(output_path: &Path, ranges: &[ByteRange]) -> Result<u64, String> {
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
        let expected = part_size(range);
        let actual = current_file_size(&range.path);
        if actual != expected {
            return Err(format!(
                "Segment {} is incomplete: expected {} bytes, got {} bytes",
                range.index, expected, actual
            ));
        }
        let mut input = File::open(&range.path).map_err(|e| format!("Could not read segment {}: {e}", range.index))?;
        let copied = std::io::copy(&mut input, &mut out).map_err(|e| format!("Could not merge segment {}: {e}", range.index))?;
        total += copied;
    }
    out.flush().map_err(|e| format!("Could not flush merged file: {e}"))?;
    out.sync_all().map_err(|e| format!("Could not fsync merged file: {e}"))?;
    drop(out);
    let _ = std::fs::remove_file(output_path);
    std::fs::rename(&tmp_path, output_path).map_err(|e| format!("Could not finalize merged file: {e}"))?;
    if let Some(parent) = output_path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    let final_size = current_file_size(output_path);
    if final_size != total {
        return Err(format!("Merged file size mismatch: expected {} bytes, got {} bytes", total, final_size));
    }
    cleanup_parts(ranges);
    Ok(total)
}

fn direct_headers(opts: &HashMap<String, serde_json::Value>) -> Result<Option<List>, String> {
    let mut list = List::new();
    let mut has_any = false;
    if let Some(raw_headers) = direct_str(opts, "headers") {
        for line in raw_headers.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if line.contains(':') {
                if !safe_value(line) {
                    return Err("Rejected unsafe header value".to_string());
                }
                list.append(line).map_err(|e| format!("Could not apply header: {e}"))?;
                has_any = true;
            }
        }
    }
    Ok(if has_any { Some(list) } else { None })
}

fn apply_easy_options(easy: &mut Easy2<SegmentWriter>, plan: &DirectDownloadPlan, range: Option<(u64, u64)>) -> Result<(), String> {
    let opts = &plan.direct_options;
    easy.url(&plan.url).map_err(|e| format!("Invalid URL: {e}"))?;
    easy.get(true).map_err(|e| format!("Could not configure GET: {e}"))?;
    easy.follow_location(plan.follow_redirects).map_err(|e| format!("Could not configure redirects: {e}"))?;
    easy.fail_on_error(plan.fail_on_error).map_err(|e| format!("Could not configure fail-on-error: {e}"))?;
    easy.progress(true).map_err(|e| format!("Could not enable progress callback: {e}"))?;

    if let Some((start, end)) = range {
        easy.range(&format!("{}-{}", start, end)).map_err(|e| format!("Could not configure range: {e}"))?;
    } else if plan.resumable {
        let existing = current_file_size(&plan.output_path);
        if existing > 0 {
            easy.resume_from(existing).map_err(|e| format!("Could not configure resume: {e}"))?;
        }
    }

    if let Some(proxy) = direct_str(opts, "proxy") {
        easy.proxy(proxy).map_err(|e| format!("Could not configure proxy: {e}"))?;
    }
    if let Some(no_proxy) = direct_str(opts, "noproxy") {
        easy.noproxy(no_proxy).map_err(|e| format!("Could not configure noproxy: {e}"))?;
    }
    if let Some(interface) = direct_str(opts, "sourceAddress").or_else(|| direct_str(opts, "interface")) {
        easy.interface(interface).map_err(|e| format!("Could not bind source interface: {e}"))?;
    }
    if let Some(user_agent) = direct_str(opts, "userAgent") {
        easy.useragent(user_agent).map_err(|e| format!("Could not configure user-agent: {e}"))?;
    }
    if let Some(referer) = plan.referer.as_deref() {
        easy.referer(referer).map_err(|e| format!("Could not configure referer: {e}"))?;
    }
    if let Some(cookies) = direct_str(opts, "cookies") {
        easy.cookie(cookies).map_err(|e| format!("Could not configure cookies: {e}"))?;
    }
    if direct_bool(opts, "compressed") == Some(true) {
        easy.accept_encoding("").map_err(|e| format!("Could not enable compression: {e}"))?;
    }
    if direct_bool(opts, "insecure") == Some(true) {
        easy.ssl_verify_peer(false).map_err(|e| format!("Could not disable TLS peer verification: {e}"))?;
        easy.ssl_verify_host(false).map_err(|e| format!("Could not disable TLS host verification: {e}"))?;
    }
    if let Some(ca) = direct_str(opts, "caCert") {
        easy.cainfo(ca).map_err(|e| format!("Could not configure CA file: {e}"))?;
    }
    if let Some(speed) = direct_u64(opts, "speedLimitBytes").or_else(|| direct_u64(opts, "speedLimitKbs").map(|v| v * 1024)).filter(|v| *v > 0) {
        easy.max_recv_speed(speed).map_err(|e| format!("Could not configure speed limit: {e}"))?;
    }
    if let Some(limit) = direct_u64(opts, "lowSpeedLimitBytes").filter(|v| *v > 0) {
        easy.low_speed_limit(limit.min(u32::MAX as u64) as u32).map_err(|e| format!("Could not configure low-speed limit: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "speedTimeSec").filter(|v| *v > 0) {
        easy.low_speed_time(Duration::from_secs(sec)).map_err(|e| format!("Could not configure low-speed time: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "timeoutSec").filter(|v| *v > 0) {
        easy.timeout(Duration::from_secs(sec)).map_err(|e| format!("Could not configure timeout: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "connectTimeoutSec").filter(|v| *v > 0) {
        easy.connect_timeout(Duration::from_secs(sec)).map_err(|e| format!("Could not configure connect timeout: {e}"))?;
    }
    if let Some(max) = direct_u64(opts, "maxRedirs") {
        easy.max_redirections(max.min(u32::MAX as u64) as u32).map_err(|e| format!("Could not configure redirect limit: {e}"))?;
    }
    match direct_str(opts, "httpVersion").unwrap_or("").to_ascii_lowercase().as_str() {
        "1.0" | "http1.0" => easy.http_version(HttpVersion::V10).map_err(|e| format!("Could not force HTTP/1.0: {e}"))?,
        "1.1" | "http1.1" => easy.http_version(HttpVersion::V11).map_err(|e| format!("Could not force HTTP/1.1: {e}"))?,
        "2" | "http2" => easy.http_version(HttpVersion::V2).map_err(|e| format!("Could not force HTTP/2: {e}"))?,
        "2-prior-knowledge" | "http2-prior-knowledge" => easy.http_version(HttpVersion::V2PriorKnowledge).map_err(|e| format!("Could not force HTTP/2 prior knowledge: {e}"))?,
        "3" | "http3" => easy.http_version(HttpVersion::V3).map_err(|e| format!("Could not force HTTP/3: {e}"))?,
        _ => {}
    }
    if let Some(headers) = direct_headers(opts)? {
        easy.http_headers(headers).map_err(|e| format!("Could not configure headers: {e}"))?;
    }
    Ok(())
}

fn create_easy_for_range(plan: &DirectDownloadPlan, path: &Path, progress: SegmentProgress, range: Option<(u64, u64)>) -> Result<Easy2<SegmentWriter>, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Could not create segment folder: {e}"))?;
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not open segment output file: {e}"))?;
    let mut easy = Easy2::new(SegmentWriter { file, progress });
    apply_easy_options(&mut easy, plan, range)?;
    Ok(easy)
}

fn update_curl_task_progress(
    state: &SharedState,
    id: &str,
    total_size: u64,
    ranges: &[(ByteRange, Arc<AtomicU64>)],
    last_total: &mut u64,
    last_tick: &mut Instant,
) {
    let downloaded = if ranges.is_empty() {
        0
    } else {
        ranges
            .iter()
            .map(|(range, _progress)| current_file_size(&range.path).min(part_size(range)))
            .sum()
    };
    let now = Instant::now();
    let elapsed = now.duration_since(*last_tick).as_secs_f64().max(0.001);
    let speed = downloaded.saturating_sub(*last_total) as f64 / elapsed;
    *last_total = downloaded;
    *last_tick = now;

    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        job.task.downloaded_bytes = downloaded;
        job.task.size_bytes = total_size;
        job.task.speed_bytes_per_sec = speed.max(0.0) as u64;
        job.task.time_left_seconds = if speed > 0.0 && total_size > downloaded {
            ((total_size - downloaded) as f64 / speed).ceil() as u64
        } else {
            0
        };
        job.task.segments = ranges
            .iter()
            .map(|(range, _progress)| {
                let seg_total = part_size(range);
                let seg_downloaded = current_file_size(&range.path).min(seg_total);
                Segment {
                    id: range.index as u32,
                    progress: if seg_total > 0 { seg_downloaded as f64 / seg_total as f64 } else { 0.0 },
                    downloaded_bytes: seg_downloaded,
                    total_bytes: seg_total,
                    active: seg_downloaded < seg_total && job.task.status == "downloading",
                    speed: 0,
                }
            })
            .collect();
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn update_single_progress(state: &SharedState, id: &str, path: &Path, total_size: u64, last_total: &mut u64, last_tick: &mut Instant) {
    let downloaded = current_file_size(path);
    let now = Instant::now();
    let elapsed = now.duration_since(*last_tick).as_secs_f64().max(0.001);
    let speed = downloaded.saturating_sub(*last_total) as f64 / elapsed;
    *last_total = downloaded;
    *last_tick = now;
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        job.task.downloaded_bytes = downloaded;
        if total_size > 0 {
            job.task.size_bytes = total_size;
        }
        job.task.speed_bytes_per_sec = speed.max(0.0) as u64;
        job.task.time_left_seconds = if speed > 0.0 && job.task.size_bytes > downloaded {
            ((job.task.size_bytes - downloaded) as f64 / speed).ceil() as u64
        } else {
            0
        };
        job.task.segments = build_segments(1, job.task.size_bytes, downloaded, true, job.task.speed_bytes_per_sec);
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn drive_multi<H: Handler>(multi: &Multi, handles: &[Easy2Handle<H>]) -> Result<(), String> {
    let mut running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
    while running > 0 {
        multi.wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| format!("libcurl multi wait failed: {e}"))?;
        running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
        let mut errors = Vec::new();
        multi.messages(|message| {
            for (idx, handle) in handles.iter().enumerate() {
                if let Some(result) = message.result_for2(handle) {
                    if let Err(error) = result {
                        errors.push(format!("segment {}: {}", idx, error));
                    }
                }
            }
        });
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    }
    let mut errors = Vec::new();
    multi.messages(|message| {
        for (idx, handle) in handles.iter().enumerate() {
            if let Some(result) = message.result_for2(handle) {
                if let Err(error) = result {
                    errors.push(format!("segment {}: {}", idx, error));
                }
            }
        }
    });
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(())
}

fn run_single_libcurl(state: &SharedState, id: &str, plan: &DirectDownloadPlan, cancel: Arc<AtomicBool>) -> Result<u64, String> {
    ensure_parent(&plan.output_path)?;
    if plan.output_path.exists() {
        let existing = current_file_size(&plan.output_path);
        if plan.total_size > 0 && existing == plan.total_size {
            return Ok(existing);
        }
        if plan.total_size > 0 && existing > plan.total_size {
            if plan.allow_overwrite {
                let _ = std::fs::remove_file(&plan.output_path);
            } else {
                return Err(format!(
                    "Destination is larger than expected and overwrite is disabled: {}",
                    plan.output_path.display()
                ));
            }
        } else if !plan.resumable {
            if !plan.allow_overwrite {
                return Err(format!("Destination already exists: {}", plan.output_path.display()));
            }
            let _ = std::fs::remove_file(&plan.output_path);
        } else if !plan.allow_overwrite && plan.total_size == 0 {
            return Err(format!(
                "Cannot safely resume existing destination without a known remote size: {}",
                plan.output_path.display()
            ));
        }
    }

    let progress = SegmentProgress { downloaded: Arc::new(AtomicU64::new(0)), abort: cancel.clone() };
    let easy = create_easy_for_range(plan, &plan.output_path, progress, None)?;
    let mut multi = Multi::new();
    multi.set_max_total_connections(1usize).map_err(|e| format!("Could not configure libcurl multi: {e}"))?;
    let handle = multi.add2(easy).map_err(|e| format!("Could not add transfer to libcurl multi: {e}"))?;
    let handles = vec![handle];
    let mut last_total = current_file_size(&plan.output_path);
    let mut last_tick = Instant::now();
    let mut running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
    while running > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        multi.wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| format!("libcurl multi wait failed: {e}"))?;
        update_single_progress(state, id, &plan.output_path, plan.total_size, &mut last_total, &mut last_tick);
        running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
        let mut errors = Vec::new();
        multi.messages(|message| {
            for handle in &handles {
                if let Some(result) = message.result_for2(handle) {
                    if let Err(error) = result {
                        errors.push(error.to_string());
                    }
                }
            }
        });
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    }
    update_single_progress(state, id, &plan.output_path, plan.total_size, &mut last_total, &mut last_tick);
    let response = handles[0].response_code().unwrap_or(0);
    if response >= 400 {
        return Err(format!("HTTP error {}", response));
    }
    Ok(current_file_size(&plan.output_path))
}

fn run_segmented_libcurl(state: &SharedState, id: &str, plan: &DirectDownloadPlan, cancel: Arc<AtomicBool>) -> Result<u64, String> {
    ensure_parent(&plan.output_path)?;
    if !plan.allow_overwrite && plan.output_path.exists() {
        let existing = current_file_size(&plan.output_path);
        if existing == plan.total_size && plan.total_size > 0 {
            return Ok(existing);
        }
        return Err(format!("Destination already exists: {}", plan.output_path.display()));
    }
    if !plan.resumable {
        let _ = std::fs::remove_file(&plan.output_path);
        remove_stale_parts_for(&plan.output_path);
    }
    if plan.output_path.exists() && current_file_size(&plan.output_path) == plan.total_size && plan.total_size > 0 {
        return Ok(plan.total_size);
    }

    let ranges = split_ranges(plan.total_size, plan.connections, &plan.output_path);
    let mut active: Vec<(ByteRange, Arc<AtomicU64>)> = Vec::new();
    let mut multi = Multi::new();
    multi.set_max_total_connections(plan.connections as usize).map_err(|e| format!("Could not configure total libcurl connections: {e}"))?;
    multi.set_max_host_connections(plan.connections as usize).map_err(|e| format!("Could not configure host libcurl connections: {e}"))?;
    multi.pipelining(false, true).map_err(|e| format!("Could not enable libcurl multiplexing: {e}"))?;

    let mut handles = Vec::new();
    for range in ranges.iter().cloned() {
        let expected = part_size(&range);
        let actual = current_file_size(&range.path);
        let existing = if actual > expected {
            let _ = std::fs::remove_file(&range.path);
            0
        } else {
            actual
        };
        if existing >= expected {
            active.push((range, Arc::new(AtomicU64::new(0))));
            continue;
        }
        let start = range.start + existing;
        let progress = Arc::new(AtomicU64::new(0));
        let easy = create_easy_for_range(
            plan,
            &range.path,
            SegmentProgress { downloaded: progress.clone(), abort: cancel.clone() },
            Some((start, range.end)),
        )?;
        let handle = multi.add2(easy).map_err(|e| format!("Could not add segment {}: {e}", range.index))?;
        handles.push(handle);
        active.push((range, progress));
    }

    if handles.is_empty() {
        return merge_parts(&plan.output_path, &ranges);
    }

    let mut last_total: u64 = active.iter().map(|(r, _p)| current_file_size(&r.path).min(part_size(r))).sum();
    let mut last_tick = Instant::now();
    let mut running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
    while running > 0 {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        multi.wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| format!("libcurl multi wait failed: {e}"))?;
        update_curl_task_progress(state, id, plan.total_size, &active, &mut last_total, &mut last_tick);
        running = multi.perform().map_err(|e| format!("libcurl multi perform failed: {e}"))?;
        let mut errors = Vec::new();
        multi.messages(|message| {
            for (idx, handle) in handles.iter().enumerate() {
                if let Some(result) = message.result_for2(handle) {
                    if let Err(error) = result {
                        errors.push(format!("segment {}: {}", idx, error));
                    }
                }
            }
        });
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }
    }
    drive_multi(&multi, &handles)?;
    for (idx, handle) in handles.iter().enumerate() {
        let code = handle.response_code().unwrap_or(0);
        if code != 206 && code != 200 {
            return Err(format!("Segment {} finished with unexpected HTTP status {}", idx, code));
        }
        if code == 200 && plan.connections > 1 {
            return Err("Server did not honor byte-range requests; retry with one connection or probe the URL again.".to_string());
        }
    }
    update_curl_task_progress(state, id, plan.total_size, &active, &mut last_total, &mut last_tick);
    merge_parts(&plan.output_path, &ranges)
}

fn run_libcurl_download(state: &SharedState, id: &str, plan: DirectDownloadPlan, cancel: Arc<AtomicBool>) -> Result<u64, String> {
    let attempts = direct_u64(&plan.direct_options, "retryCount")
        .unwrap_or(0)
        .saturating_add(1)
        .min(50);
    let retry_delay = Duration::from_secs(
        direct_u64(&plan.direct_options, "retryDelaySec").unwrap_or(2).min(3600),
    );
    let mut last_error = String::new();
    for attempt in 0..attempts {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let result = if plan.segmented {
            run_segmented_libcurl(state, id, &plan, cancel.clone())
        } else {
            run_single_libcurl(state, id, &plan, cancel.clone())
        };
        match result {
            Ok(size) => return Ok(size),
            Err(error) if error == "cancelled" || cancel.load(Ordering::Relaxed) => return Err("cancelled".to_string()),
            Err(error) => {
                last_error = error;
                if attempt + 1 < attempts {
                    std::thread::sleep(retry_delay);
                }
            }
        }
    }
    Err(last_error)
}

fn mark_curl_task_finished(state: &SharedState, id: &str, final_size: u64, generation: u64) {
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.run_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        job.task.status = "completed".to_string();
        job.task.downloaded_bytes = final_size;
        if job.task.size_bytes == 0 {
            job.task.size_bytes = final_size;
        }
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some("completed".to_string());
        job.task.error_message = None;
        job.task.segments = build_segments(job.task.connections, job.task.size_bytes, final_size, false, 0);
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn mark_curl_task_failed(state: &SharedState, id: &str, message: String, cancelled: bool, generation: u64) {
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.run_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        job.task.status = if cancelled { "paused" } else { "error" }.to_string();
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some(if cancelled { "paused" } else { "failed" }.to_string());
        job.task.error_message = if cancelled { None } else { Some(message.clone()) };
        let task = job.task.clone();
        let remove_on_error = job.direct_options.get("removeOnError").and_then(|v| v.as_bool()).unwrap_or(false);
        let path = PathBuf::from(&job.task.save_path);
        drop(jobs);
        if !cancelled && remove_on_error {
            let _ = std::fs::remove_file(&path);
            remove_stale_parts_for(&path);
        }
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

pub fn start_curl_process(state: &SharedState, id: &str) {
    let record = {
        let mut jobs = lock_or_err!(state.curl_jobs);
        let Some(job) = jobs.get_mut(id) else { return; };
        if job.task.status == "completed" {
            return;
        }
        if matches!(job.task.status.as_str(), "downloading" | "pausing" | "stopping") {
            return;
        }
        job.cancel_token = Arc::new(AtomicBool::new(false));
        let generation = job.run_generation.fetch_add(1, Ordering::Relaxed).saturating_add(1);
        job.task.status = "downloading".to_string();
        job.task.engine_status = Some("running-libcurl-multi".to_string());
        job.task.error_message = None;
        let plan = plan_from_job(job);
        let token = job.cancel_token.clone();
        (plan, token, generation)
    };
    state.mark_dirty();

    let state2 = state.clone();
    let id2 = id.to_string();
    std::thread::spawn(move || {
        let (plan, cancel, generation) = record;
        log::info!("Starting libcurl multi transfer for task {} generation {}", id2, generation);
        let result = run_libcurl_download(&state2, &id2, plan.clone(), cancel.clone());
        match result {
            Ok(final_size) => mark_curl_task_finished(&state2, &id2, final_size, generation),
            Err(error) => {
                let cancelled = cancel.load(Ordering::Relaxed) || error == "cancelled";
                if !cancelled && plan.remove_on_error {
                    let _ = std::fs::remove_file(&plan.output_path);
                    remove_stale_parts_for(&plan.output_path);
                }
                mark_curl_task_failed(&state2, &id2, error, cancelled, generation);
            }
        }
    });
}

pub async fn create_curl_task(state: &SharedState, body: &CreateDownloadBody) -> Result<Task, String> {
    let url = body.url.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing url".to_string());
    }
    if url.starts_with('-') {
        return Err("Invalid url: must not start with '-'".to_string());
    }
    if url.starts_with("magnet:") || url.to_lowercase().ends_with(".torrent") || url.contains(".torrent?") {
        return Err("Torrent/magnet support requires a dedicated torrent engine; libcurl multi is for direct URL downloads.".to_string());
    }

    // A build-vs-runtime libcurl integrity discrepancy (e.g. the linked libcurl
    // reporting fewer protocols than the pinned build baked in as "expected") is a
    // diagnostic concern surfaced via the daemon status endpoint. It must not block
    // a direct download whose own protocol is supported: the per-download check
    // below (validate_curl_direct_options) enforces exactly what this transfer needs.
    if let Err(integrity_error) = engine_capabilities::validate_linked_libcurl_integrity() {
        log::warn!(
            "libcurl integrity discrepancy; continuing because per-download capabilities are validated separately: {integrity_error}"
        );
    }

    let direct_options = body.direct_options.clone().unwrap_or_default();
    engine_capabilities::validate_curl_direct_options(
        &state.curl_bin,
        &direct_options,
        body.resumable.unwrap_or(true),
    )?;

    let (name, output_path) = destination_from_body(body, url);
    ensure_parent(&output_path)?;
    let fail_with_body_supported = engine_capabilities::curl_supports_flag(&state.curl_bin, "--fail-with-body");
    let args = build_curl_args_with_capabilities(body, &output_path, fail_with_body_supported)?;
    let id = Uuid::new_v4().to_string();
    let job = task_from_body(body, &id, name, &output_path, args, direct_options);
    let task = job.task.clone();
    lock_or_err!(state.curl_jobs).insert(id.clone(), job);
    lock_or_err!(state.task_snapshot).insert(id.clone(), task.clone());
    state.mark_dirty();

    if body.start_immediately.unwrap_or(true) {
        start_curl_process(state, &id);
    }
    Ok(task)
}

pub async fn list_all_tasks(state: &SharedState) -> Vec<Task> {
    let mut tasks: Vec<Task> = lock_or_err!(state.media_jobs).values().map(|j| j.task.clone()).collect();
    tasks.extend(lock_or_err!(state.curl_jobs).values().map(|j| j.task.clone()));

    let active_ids: HashSet<String> = tasks.iter().map(|t| t.id.clone()).collect();
    let mut snapshot = lock_or_err!(state.task_snapshot);
    for task in snapshot.values() {
        if !active_ids.contains(&task.id) {
            tasks.push(task.clone());
        }
    }

    let mut changed = snapshot.len() != tasks.len();
    if !changed {
        for task in &tasks {
            let same = snapshot.get(&task.id).is_some_and(|old| {
                old.status == task.status
                    && old.downloaded_bytes == task.downloaded_bytes
                    && old.size_bytes == task.size_bytes
                    && old.name == task.name
                    && old.save_path == task.save_path
                    && old.engine == task.engine
            });
            if !same {
                changed = true;
                break;
            }
        }
    }
    if changed {
        *snapshot = tasks.iter().map(|t| (t.id.clone(), t.clone())).collect();
        state.mark_dirty();
    }
    tasks
}

pub async fn pause_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if let Some(pid) = job.child {
                kill_process(pid);
                job.child = None;
            }
            job.task.status = "paused".to_string();
            job.task.speed_bytes_per_sec = 0;
            job.task.engine_status = Some("paused".to_string());
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            return Ok(task);
        }
    }

    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(id) {
            job.cancel_token.store(true, Ordering::Relaxed);
            if job.task.status == "downloading" {
                job.task.status = "pausing".to_string();
                job.task.engine_status = Some("pausing".to_string());
            } else {
                job.task.status = "paused".to_string();
                job.task.engine_status = Some("paused".to_string());
            }
            job.task.speed_bytes_per_sec = 0;
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            return Ok(task);
        }
    }

    let snapshot = lock_or_err!(state.task_snapshot);
    snapshot.get(id).cloned().ok_or_else(|| "Task not found".to_string())
}

pub async fn resume_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            let needs_start = job.task.status != "completed";
            if needs_start {
                job.task.status = "downloading".to_string();
                job.task.engine_status = Some("resuming".to_string());
            }
            drop(jobs);
            if needs_start {
                crate::daemon::ytdlp::start_ytdlp_process(state, id);
            }
            state.mark_dirty();
            let jobs = lock_or_err!(state.media_jobs);
            return jobs.get(id).map(|j| j.task.clone()).ok_or_else(|| "Task not found after resume".to_string());
        }
    }

    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if job.task.status == "completed" {
                return Err(format!("Cannot resume '{}': download is already completed.", job.task.name));
            }
            if matches!(job.task.status.as_str(), "downloading" | "pausing" | "stopping") {
                return Err(format!("Cannot resume '{}': current state is {}. Wait until the previous libcurl worker has stopped.", job.task.name, job.task.status));
            }
            job.task.status = "queued".to_string();
            job.task.engine_status = Some("resume-requested".to_string());
            job.task.error_message = None;
            let task = job.task.clone();
            drop(jobs);
            start_curl_process(state, id);
            state.mark_dirty();
            return Ok(task);
        }
    }

    Err("Task not found".to_string())
}

pub async fn delete_task(state: &SharedState, id: &str, delete_files: bool) -> Result<(), String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.remove(id) {
            if let Some(pid) = job.child { kill_process(pid); }
            let path = PathBuf::from(&job.task.save_path);
            drop(jobs);
            if delete_files {
                let _ = std::fs::remove_file(&path);
            }
            lock_or_err!(state.task_snapshot).remove(id);
            state.mark_dirty();
            return Ok(());
        }
    }
    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.remove(id) {
            job.cancel_token.store(true, Ordering::Relaxed);
            job.run_generation.fetch_add(1, Ordering::Relaxed);
            let path = PathBuf::from(&job.task.save_path);
            drop(jobs);
            if delete_files {
                let _ = std::fs::remove_file(&path);
                remove_stale_parts_for(&path);
            }
            lock_or_err!(state.task_snapshot).remove(id);
            state.mark_dirty();
            return Ok(());
        }
    }

    if lock_or_err!(state.task_snapshot).remove(id).is_some() {
        state.mark_dirty();
        Ok(())
    } else {
        Err("Task not found".to_string())
    }
}

pub fn curl_version(_curl_bin: &str) -> String {
    let v = ::curl::Version::get();
    format!("libcurl {}", v.version())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_body() -> CreateDownloadBody {
        CreateDownloadBody {
            url: Some("https://example.com/file.bin".to_string()),
            name: Some("file.bin".to_string()),
            file_type: None,
            size_bytes: Some(1000),
            category: None,
            queue_id: None,
            connections: Some(24),
            resumable: Some(true),
            save_path: Some("C:/Downloads/file.bin".to_string()),
            description: None,
            referer: Some("https://example.com/page".to_string()),
            start_immediately: Some(false),
            direct_options: None,
            media_options: None,
        }
    }

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2).any(|pair| pair[0] == flag && pair[1] == value)
    }

    #[test]
    fn build_curl_args_applies_direct_settings() {
        let mut direct_options = HashMap::new();
        direct_options.insert("headers".to_string(), serde_json::json!("Authorization: Bearer token\nX-Test: yes"));
        direct_options.insert("cookies".to_string(), serde_json::json!("sid=abc"));
        direct_options.insert("userAgent".to_string(), serde_json::json!("NOVA-Test"));
        direct_options.insert("sourceAddress".to_string(), serde_json::json!("10.8.0.2"));
        direct_options.insert("retryCount".to_string(), serde_json::json!(5));
        direct_options.insert("timeoutSec".to_string(), serde_json::json!(45));
        direct_options.insert("allowOverwrite".to_string(), serde_json::json!(false));
        direct_options.insert("compressed".to_string(), serde_json::json!(true));

        let mut body = base_body();
        body.direct_options = Some(direct_options);

        let args = build_curl_args(&body, Path::new("C:/Downloads/file.bin")).unwrap();

        assert!(args.contains(&"--location".to_string()));
        assert!(has_pair(&args, "--output", "C:/Downloads/file.bin"));
        assert!(has_pair(&args, "--user-agent", "NOVA-Test"));
        assert!(has_pair(&args, "--interface", "10.8.0.2"));
        assert!(has_pair(&args, "--retry", "5"));
        assert!(has_pair(&args, "--max-time", "45"));
        assert!(has_pair(&args, "--referer", "https://example.com/page"));
        assert!(has_pair(&args, "--header", "Authorization: Bearer token"));
        assert!(has_pair(&args, "--header", "X-Test: yes"));
        assert!(has_pair(&args, "--cookie", "sid=abc"));
        assert!(args.contains(&"--no-clobber".to_string()));
        assert!(args.contains(&"--compressed".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("https://example.com/file.bin"));
    }

    #[test]
    fn build_curl_args_rejects_torrents() {
        let mut body = base_body();
        body.url = Some("magnet:?xt=urn:btih:abc".to_string());
        assert!(build_curl_args(&body, Path::new("file.torrent")).is_err());
    }

    #[test]
    fn build_curl_args_accepts_browser_user_agent() {
        let mut direct_options = HashMap::new();
        let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NOVA/0.1.0";
        direct_options.insert("userAgent".to_string(), serde_json::json!(user_agent));

        let mut body = base_body();
        body.direct_options = Some(direct_options);

        let args = build_curl_args(&body, Path::new("C:/Downloads/file.bin")).unwrap();

        assert!(has_pair(&args, "--user-agent", user_agent));
    }

    #[test]
    fn split_ranges_are_contiguous() {
        let ranges = split_ranges(100, 6, Path::new("file.bin"));
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(ranges.last().unwrap().end, 99);
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }
}
