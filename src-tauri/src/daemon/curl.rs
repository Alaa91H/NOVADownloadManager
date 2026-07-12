use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use uuid::Uuid;

use ::curl::easy::{
    Auth, Easy2, Handler, HttpVersion, IpResolve, List, NetRc, ProxyType, SslOpt, SslVersion,
    TimeCondition, WriteError,
};
use ::curl::multi::{Easy2Handle, Events, Multi, Socket, WaitFd};

use crate::daemon::direct::{
    ConnectionLimits, DirectUrl, EventLoopMode, FileWriter, IntegrityMetadata, IntegrityValidator,
    RetryPolicy, SegmentPlanner, SegmentRange as ByteRange,
};
use crate::daemon::engine_capabilities;
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, CurlJob, Segment, Task};
use crate::daemon::utils::{
    build_segments, infer_file_type, kill_process, now_str, push_arg, DEFAULT_USER_AGENT,
};
use crate::lock_or_err;

const FALLBACK_USER_AGENT: &str = DEFAULT_USER_AGENT;

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

#[derive(Clone)]
struct SegmentProgress {
    downloaded: Arc<AtomicU64>,
    abort: Arc<AtomicBool>,
}

struct SegmentWriter {
    file: File,
    progress: SegmentProgress,
}

#[derive(Clone, Copy, Debug)]
struct SocketUpdate {
    socket: Socket,
    token: usize,
    input: bool,
    output: bool,
    remove: bool,
}

#[derive(Clone, Copy, Debug)]
struct SocketInterest {
    input: bool,
    output: bool,
}

struct MultiSocketRuntime {
    updates: Arc<Mutex<Vec<SocketUpdate>>>,
    timeout: Arc<Mutex<Option<Duration>>>,
    sockets: HashMap<Socket, SocketInterest>,
    next_token: usize,
}

impl Handler for SegmentWriter {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.progress.abort.load(Ordering::Relaxed) {
            return Ok(0);
        }
        match self.file.write_all(data) {
            Ok(()) => {
                self.progress
                    .downloaded
                    .fetch_add(data.len() as u64, Ordering::Relaxed);
                Ok(data.len())
            }
            Err(e) => {
                log::warn!("SegmentWriter write error: {}", e);
                self.progress.abort.store(true, Ordering::Relaxed);
                Err(WriteError::Pause)
            }
        }
    }

    fn progress(&mut self, _dltotal: f64, _dlnow: f64, _ultotal: f64, _ulnow: f64) -> bool {
        !self.progress.abort.load(Ordering::Relaxed)
    }
}

impl MultiSocketRuntime {
    fn attach(multi: &mut Multi) -> Result<Self, String> {
        let updates = Arc::new(Mutex::new(Vec::new()));
        let socket_updates = updates.clone();
        multi
            .socket_function(move |socket, events, token| {
                if let Ok(mut updates) = socket_updates.lock() {
                    updates.push(SocketUpdate {
                        socket,
                        token,
                        input: events.input(),
                        output: events.output(),
                        remove: events.remove(),
                    });
                }
            })
            .map_err(|e| format!("Could not configure libcurl socket callback: {e}"))?;

        let timeout = Arc::new(Mutex::new(None));
        let timer_timeout = timeout.clone();
        multi
            .timer_function(move |duration| {
                if let Ok(mut timeout) = timer_timeout.lock() {
                    *timeout = duration;
                }
                true
            })
            .map_err(|e| format!("Could not configure libcurl timer callback: {e}"))?;

        Ok(Self {
            updates,
            timeout,
            sockets: HashMap::new(),
            next_token: 1,
        })
    }

    fn drain_updates(&mut self, multi: &Multi) -> Result<(), String> {
        let updates = {
            let mut guard = self
                .updates
                .lock()
                .map_err(|_| "libcurl socket update queue is poisoned".to_string())?;
            std::mem::take(&mut *guard)
        };

        for update in updates {
            if update.remove {
                self.sockets.remove(&update.socket);
                continue;
            }
            if !update.input && !update.output {
                self.sockets.remove(&update.socket);
                continue;
            }

            if update.token == 0 {
                let token = self.next_token;
                self.next_token = self.next_token.saturating_add(1);
                multi
                    .assign(update.socket, token)
                    .map_err(|e| format!("Could not assign libcurl socket token: {e}"))?;
            }

            self.sockets.insert(
                update.socket,
                SocketInterest {
                    input: update.input,
                    output: update.output,
                },
            );
        }
        Ok(())
    }

    fn wait_timeout(&self) -> Duration {
        let progress_interval = Duration::from_millis(PROGRESS_INTERVAL_MS);
        let timeout = self
            .timeout
            .lock()
            .ok()
            .and_then(|timeout| *timeout)
            .unwrap_or(progress_interval);
        timeout.min(progress_interval)
    }

    fn wait_fds(&self) -> Vec<(Socket, WaitFd)> {
        self.sockets
            .iter()
            .filter(|(_, interest)| interest.input || interest.output)
            .map(|(socket, interest)| {
                let mut wait_fd = WaitFd::new();
                wait_fd.set_fd(*socket);
                wait_fd.poll_on_read(interest.input);
                wait_fd.poll_on_write(interest.output);
                (*socket, wait_fd)
            })
            .collect()
    }
}

#[inline]
fn direct_str<'a>(
    direct_options: &'a HashMap<String, serde_json::Value>,
    key: &str,
) -> Option<&'a str> {
    direct_options
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

#[inline]
fn direct_bool(direct_options: &HashMap<String, serde_json::Value>, key: &str) -> Option<bool> {
    direct_options.get(key).and_then(|v| v.as_bool())
}

#[inline]
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

#[inline]
fn safe_value(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\0', '\n', '\r'])
}

fn push_optional_arg(
    args: &mut Vec<String>,
    flag: &str,
    value: Option<&str>,
) -> Result<(), String> {
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
        let parts = crate::daemon::utils::shell_split(line);
        let option = parts.first().map(String::as_str).unwrap_or("");
        let allowed = ALLOWED_CURL_RAW_OPTIONS
            .iter()
            .any(|allowed| option == *allowed || option.starts_with(&format!("{}=", allowed)));
        let safe = !line.contains(|c: char| {
            c == ';' || c == '|' || c == '&' || c == '$' || c == '`' || c == '\n' || c == '\r'
        });
        if !allowed || !safe {
            return Err(format!("Rejected unsupported curl raw option '{}'", line));
        }
        args.extend(parts);
    }
    Ok(())
}

#[inline]
fn requested_connections(connections: Option<u32>) -> u32 {
    match connections.unwrap_or(0) {
        0 => DEFAULT_DIRECT_CONNECTIONS,
        n => n.clamp(1, MAX_DIRECT_CONNECTIONS),
    }
}

#[inline]
fn file_name_from_url(url: &str) -> String {
    let path = url.split('?').next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("download").trim();
    if name.is_empty() {
        "download".to_string()
    } else {
        name.to_string()
    }
}

fn destination_from_body(body: &CreateDownloadBody, url: &str) -> (String, PathBuf) {
    let name = body.name.clone().unwrap_or_else(|| file_name_from_url(url));
    if let Some(save_path) = body
        .save_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        let path = PathBuf::from(save_path);
        return (name, path);
    }
    (name.clone(), PathBuf::from(name))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    FileWriter::ensure_parent(path)
}

fn current_file_size(path: &Path) -> u64 {
    FileWriter::current_size(path)
}

pub(crate) fn build_curl_args(
    body: &CreateDownloadBody,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    build_curl_args_with_capabilities(body, output_path, true)
}

fn build_curl_args_with_capabilities(
    body: &CreateDownloadBody,
    output_path: &Path,
    fail_with_body_supported: bool,
) -> Result<Vec<String>, String> {
    let raw_url = body.url.as_deref().unwrap_or("").trim();
    let direct_url = DirectUrl::parse(raw_url)?;
    let url = direct_url.normalized.as_str();
    if url.starts_with("magnet:")
        || url.to_lowercase().ends_with(".torrent")
        || url.contains(".torrent?")
    {
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
        push_optional_arg(
            &mut args,
            "--interface",
            direct_str(dopts, "sourceAddress").or_else(|| direct_str(dopts, "interface")),
        )?;
        let ua = direct_str(dopts, "userAgent").unwrap_or(FALLBACK_USER_AGENT);
        push_arg(&mut args, "--user-agent", ua);
        if let Some(referer) = direct_str(dopts, "referer") {
            referer_from_direct = Some(referer.to_string());
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitKbs").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &format!("{}K", speed));
        }
        if let Some(speed) = direct_u64(dopts, "speedLimitBytes").filter(|speed| *speed > 0) {
            push_arg(&mut args, "--limit-rate", &speed.to_string());
        }
        push_optional_u64(
            &mut args,
            "--speed-limit",
            direct_u64(dopts, "lowSpeedLimitBytes"),
        );
        push_optional_u64(&mut args, "--speed-time", direct_u64(dopts, "speedTimeSec"));
        if let Some(username) = direct_str(dopts, "username") {
            let password = direct_str(dopts, "password").unwrap_or("");
            push_arg(&mut args, "--user", &format!("{}:{}", username, password));
        }
        if let Some(retries) = direct_u64(dopts, "retryCount") {
            push_arg(&mut args, "--retry", &retries.to_string());
        }
        push_optional_u64(
            &mut args,
            "--retry-delay",
            direct_u64(dopts, "retryDelaySec"),
        );
        push_optional_u64(
            &mut args,
            "--retry-max-time",
            direct_u64(dopts, "retryMaxTimeSec"),
        );
        push_optional_u64(&mut args, "--max-time", direct_u64(dopts, "timeoutSec"));
        push_optional_u64(
            &mut args,
            "--connect-timeout",
            direct_u64(dopts, "connectTimeoutSec"),
        );
        push_optional_u64(&mut args, "--max-redirs", direct_u64(dopts, "maxRedirs"));
        push_optional_u64(
            &mut args,
            "--max-filesize",
            direct_u64(dopts, "maxFilesize"),
        );
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

        match direct_str(dopts, "httpVersion")
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "1.0" | "http1.0" => args.push("--http1.0".to_string()),
            "1.1" | "http1.1" => args.push("--http1.1".to_string()),
            "2" | "http2" => args.push("--http2".to_string()),
            "2-prior-knowledge" | "http2-prior-knowledge" => {
                args.push("--http2-prior-knowledge".to_string())
            }
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

    if let Some(referer) = referer_from_direct.as_deref().or_else(|| {
        body.referer
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
    }) {
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
        status: if body.start_immediately.unwrap_or(true) {
            "downloading"
        } else {
            "queued"
        }
        .to_string(),
        size_bytes: initial_size,
        downloaded_bytes: downloaded,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: now_str(),
        category,
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_string()),
        connections: requested_connections(body.connections),
        resumable: body.resumable.unwrap_or(true),
        save_path: output_path.to_string_lossy().to_string(),
        description: body
            .description
            .clone()
            .unwrap_or_else(|| "Direct download via libcurl multi".to_string()),
        segments: build_segments(
            requested_connections(body.connections),
            initial_size,
            downloaded,
            true,
            0,
        ),
        referer: body.referer.clone(),
        engine: "libcurl-multi".to_string(),
        engine_id: id.to_string(),
        engine_status: Some(
            if body.start_immediately.unwrap_or(true) {
                "starting"
            } else {
                "queued"
            }
            .to_string(),
        ),
        error_message: None,
        torrent_metadata: None,
    };
    CurlJob {
        task,
        args,
        direct_options,
        cancel_token: Arc::new(AtomicBool::new(false)),
        run_generation: Arc::new(AtomicU64::new(0)),
        start_time: Instant::now(),
        segment_prev_bytes: Vec::new(),
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
        referer: direct_str(&opts, "referer")
            .map(str::to_string)
            .or_else(|| job.task.referer.clone()),
        direct_options: opts,
    }
}

fn split_ranges(total_size: u64, connections: u32, output_path: &Path) -> Vec<ByteRange> {
    SegmentPlanner::new(MAX_DIRECT_CONNECTIONS).plan(total_size, connections, output_path)
}

fn part_size(range: &ByteRange) -> u64 {
    range.len()
}

fn remove_stale_parts_for(output_path: &Path) {
    FileWriter::remove_stale_parts_for(output_path);
}

fn merge_parts(output_path: &Path, ranges: &[ByteRange]) -> Result<u64, String> {
    FileWriter::merge_parts(output_path, ranges)
}

fn configure_multi_limits(multi: &mut Multi, limits: ConnectionLimits) -> Result<(), String> {
    multi
        .set_max_total_connections(limits.total)
        .map_err(|e| format!("Could not configure total libcurl connections: {e}"))?;
    multi
        .set_max_host_connections(limits.per_host)
        .map_err(|e| format!("Could not configure host libcurl connections: {e}"))?;
    multi
        .set_max_connects(limits.cache)
        .map_err(|e| format!("Could not configure libcurl connection cache: {e}"))?;
    Ok(())
}

fn collect_multi_errors<H: Handler>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    label: &str,
) -> Vec<String> {
    let mut errors = Vec::new();
    multi.messages(|message| {
        for (idx, handle) in handles.iter().enumerate() {
            if let Some(Err(error)) = message.result_for2(handle) {
                if handles.len() == 1 {
                    errors.push(error.to_string());
                } else {
                    errors.push(format!("{} {}: {}", label, idx, error));
                }
            }
        }
    });
    errors
}

fn check_multi_messages<H: Handler>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    label: &str,
) -> Result<(), String> {
    let errors = collect_multi_errors(multi, handles, label);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn drive_multi_wait_perform<H, F>(
    multi: &Multi,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    mut tick: F,
) -> Result<(), String>
where
    H: Handler,
    F: FnMut(),
{
    let mut running = multi
        .perform()
        .map_err(|e| format!("libcurl multi perform failed: {e}"))?;
    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }
        multi
            .wait(&mut [], Duration::from_millis(PROGRESS_INTERVAL_MS))
            .map_err(|e| format!("libcurl multi wait failed: {e}"))?;
        tick();
        running = multi
            .perform()
            .map_err(|e| format!("libcurl multi perform failed: {e}"))?;
        check_multi_messages(multi, handles, label)?;
    }
    tick();
    check_multi_messages(multi, handles, label)
}

fn drive_multi_socket<H, F>(
    multi: &Multi,
    runtime: &mut MultiSocketRuntime,
    handles: &[Easy2Handle<H>],
    cancel: &AtomicBool,
    label: &str,
    mut tick: F,
) -> Result<(), String>
where
    H: Handler,
    F: FnMut(),
{
    let mut running = handles.len() as u32;
    runtime.drain_updates(multi)?;
    if runtime.sockets.is_empty() {
        running = multi
            .timeout()
            .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
        runtime.drain_updates(multi)?;
    }

    while running > 0 {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }

        let timeout = runtime.wait_timeout();
        if timeout.is_zero() || runtime.sockets.is_empty() {
            if !timeout.is_zero() && runtime.sockets.is_empty() {
                std::thread::sleep(timeout);
            }
            running = multi
                .timeout()
                .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
            runtime.drain_updates(multi)?;
            tick();
            check_multi_messages(multi, handles, label)?;
            continue;
        }

        let wait_fds = runtime.wait_fds();
        let sockets: Vec<Socket> = wait_fds.iter().map(|(socket, _)| *socket).collect();
        let interests: Vec<SocketInterest> = sockets
            .iter()
            .filter_map(|socket| runtime.sockets.get(socket).copied())
            .collect();
        let mut wait_fds: Vec<WaitFd> = wait_fds.into_iter().map(|(_, wait_fd)| wait_fd).collect();
        let ready_count = multi
            .wait(&mut wait_fds, timeout)
            .map_err(|e| format!("libcurl multi socket wait failed: {e}"))?;

        let mut dispatched = 0u32;
        for (idx, wait_fd) in wait_fds.iter().enumerate() {
            let mut events = Events::new();
            let mut ready = false;
            if wait_fd.received_read() || wait_fd.received_priority_read() {
                events.input(true);
                ready = true;
            }
            if wait_fd.received_write() {
                events.output(true);
                ready = true;
            }
            if ready {
                dispatched = dispatched.saturating_add(1);
                running = multi
                    .action(sockets[idx], &events)
                    .map_err(|e| format!("libcurl multi socket action failed: {e}"))?;
                runtime.drain_updates(multi)?;
            }
        }

        if wait_fds.is_empty() || ready_count == 0 {
            running = multi
                .timeout()
                .map_err(|e| format!("libcurl multi timeout action failed: {e}"))?;
            runtime.drain_updates(multi)?;
        } else if dispatched == 0 {
            for (idx, interest) in interests.iter().enumerate() {
                let mut events = Events::new();
                events.input(interest.input);
                events.output(interest.output);
                running = multi
                    .action(sockets[idx], &events)
                    .map_err(|e| format!("libcurl multi socket action failed: {e}"))?;
                runtime.drain_updates(multi)?;
            }
        }

        tick();
        check_multi_messages(multi, handles, label)?;
    }

    tick();
    check_multi_messages(multi, handles, label)
}

fn direct_headers(opts: &HashMap<String, serde_json::Value>) -> Result<Option<List>, String> {
    let mut list = List::new();
    let mut has_any = false;
    if let Some(raw_headers) = direct_str(opts, "headers") {
        for line in raw_headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if line.contains(':') {
                if !safe_value(line) {
                    return Err("Rejected unsafe header value".to_string());
                }
                list.append(line)
                    .map_err(|e| format!("Could not apply header: {e}"))?;
                has_any = true;
            }
        }
    }
    Ok(if has_any { Some(list) } else { None })
}

/// Returns the path to the bundled CA certificate bundle if it exists.
/// Checks alongside the executable and in the CARGO_MANIFEST_DIR (dev mode).
use std::sync::OnceLock;

static CA_BUNDLE_PATH: OnceLock<String> = OnceLock::new();

fn installed_ca_bundle_path() -> &'static str {
    CA_BUNDLE_PATH.get_or_init(|| {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(parent) = exe_path.parent() {
                let candidate = parent.join("cacert.pem");
                if candidate.exists() {
                    return candidate.display().to_string();
                }
            }
        }
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest.join("cacert.pem");
        if candidate.exists() {
            return candidate.display().to_string();
        }
        String::new()
    })
}

static SSL_INIT: OnceLock<()> = OnceLock::new();

/// Initialise SSL for the curl engine. Call once at daemon start so that
/// OpenSSL can discover the bundled CA certificate bundle.
pub fn init_download_ssl() {
    SSL_INIT.get_or_init(|| {
        let ca_path = installed_ca_bundle_path();
        if !ca_path.is_empty() {
            // CA bundle is applied per-Easy2 handle via CURLOPT_CAINFO in
            // apply_easy_options(). We avoid set_var("SSL_CERT_FILE") because
            // it is process-global, unsafe in multi-threaded contexts, and
            // redundant with per-handle cainfo.
            log::info!("curl SSL using bundled CA: {}", ca_path);
        } else {
            log::warn!("No bundled CA certificate found; HTTPS downloads may fail if OpenSSL cannot locate system CA certs.");
        }
    });
}

fn apply_easy_options(
    easy: &mut Easy2<SegmentWriter>,
    plan: &DirectDownloadPlan,
    range: Option<(u64, u64)>,
) -> Result<(), String> {
    let opts = &plan.direct_options;
    easy.url(&plan.url)
        .map_err(|e| format!("Invalid URL: {e}"))?;
    easy.get(true)
        .map_err(|e| format!("Could not configure GET: {e}"))?;
    easy.follow_location(plan.follow_redirects)
        .map_err(|e| format!("Could not configure redirects: {e}"))?;
    easy.fail_on_error(plan.fail_on_error)
        .map_err(|e| format!("Could not configure fail-on-error: {e}"))?;
    easy.progress(true)
        .map_err(|e| format!("Could not enable progress callback: {e}"))?;
    // Allow up to 20 redirects by default (CDNs like videolan often chain multiple redirects)
    if direct_u64(opts, "maxRedirs").is_none() {
        easy.max_redirections(20)
            .map_err(|e| format!("Could not configure default redirect limit: {e}"))?;
    }
    // Automatically set the Referer header when following redirects (crucial for CDNs)
    easy.autoreferer(true)
        .map_err(|e| format!("Could not enable auto-referer: {e}"))?;
    // Enable TCP keepalive for long-running downloads
    easy.tcp_keepalive(true)
        .map_err(|e| format!("Could not enable TCP keepalive: {e}"))?;

    if let Some((start, end)) = range {
        easy.range(&format!("{}-{}", start, end))
            .map_err(|e| format!("Could not configure range: {e}"))?;
    } else if plan.resumable {
        let existing = current_file_size(&plan.output_path);
        if existing > 0 {
            easy.resume_from(existing)
                .map_err(|e| format!("Could not configure resume: {e}"))?;
        }
    }

    if let Some(proxy) = direct_str(opts, "proxy") {
        easy.proxy(proxy)
            .map_err(|e| format!("Could not configure proxy: {e}"))?;
    }
    if let Some(no_proxy) = direct_str(opts, "noproxy") {
        easy.noproxy(no_proxy)
            .map_err(|e| format!("Could not configure noproxy: {e}"))?;
    }
    if let Some(interface) =
        direct_str(opts, "sourceAddress").or_else(|| direct_str(opts, "interface"))
    {
        easy.interface(interface)
            .map_err(|e| format!("Could not bind source interface: {e}"))?;
    }
    let user_agent = direct_str(opts, "userAgent").unwrap_or(FALLBACK_USER_AGENT);
    easy.useragent(user_agent)
        .map_err(|e| format!("Could not configure user-agent: {e}"))?;
    if let Some(referer) = plan.referer.as_deref() {
        easy.referer(referer)
            .map_err(|e| format!("Could not configure referer: {e}"))?;
    }
    if let Some(cookies) = direct_str(opts, "cookies") {
        easy.cookie(cookies)
            .map_err(|e| format!("Could not configure cookies: {e}"))?;
    }
    // Enable compression (Accept-Encoding) by default for CDN compatibility
    if direct_bool(opts, "compressed") != Some(false) {
        easy.accept_encoding("")
            .map_err(|e| format!("Could not enable compression: {e}"))?;
    }
    if direct_bool(opts, "insecure") == Some(true) {
        log::warn!(
            "TLS verification disabled via 'insecure' option for download from {}",
            plan.url
        );
        easy.ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable TLS peer verification: {e}"))?;
        easy.ssl_verify_host(false)
            .map_err(|e| format!("Could not disable TLS host verification: {e}"))?;
    }
    if let Some(ca) = direct_str(opts, "caCert") {
        easy.cainfo(ca)
            .map_err(|e| format!("Could not configure CA file: {e}"))?;
    } else if !installed_ca_bundle_path().is_empty() {
        // If the user didn't specify a custom CA, try our bundled one.
        if let Err(e) = easy.cainfo(installed_ca_bundle_path()) {
            log::warn!("Could not set bundled CA file: {}", e);
        }
    }
    if let Some(doh) = direct_str(opts, "dohUrl") {
        easy.doh_url(Some(doh))
            .map_err(|e| format!("Could not configure DNS-over-HTTPS: {e}"))?;
    }
    if let Some(dns) = direct_str(opts, "dnsServers") {
        easy.dns_servers(dns)
            .map_err(|e| format!("Could not configure DNS servers: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "dnsCacheTimeoutSec") {
        easy.dns_cache_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure DNS cache timeout: {e}"))?;
    }
    if let Some(jar) = direct_str(opts, "cookieJar") {
        easy.cookie_jar(jar)
            .map_err(|e| format!("Could not configure cookie jar: {e}"))?;
    }
    if let Some(pubkey) = direct_str(opts, "pinnedPubKey") {
        easy.pinned_public_key(pubkey)
            .map_err(|e| format!("Could not configure certificate pinning: {e}"))?;
    }
    if let Some(size) = direct_u64(opts, "maxFilesize").filter(|v| *v > 0) {
        easy.max_filesize(size)
            .map_err(|e| format!("Could not configure max file size: {e}"))?;
    }
    if let Some(size) = direct_u64(opts, "bufferSize").filter(|v| *v > 0) {
        easy.buffer_size(size as usize)
            .map_err(|e| format!("Could not configure buffer size: {e}"))?;
    }
    if let Some(speed) = direct_u64(opts, "speedLimitBytes")
        .or_else(|| direct_u64(opts, "speedLimitKbs").map(|v| v * 1024))
        .filter(|v| *v > 0)
    {
        easy.max_recv_speed(speed)
            .map_err(|e| format!("Could not configure speed limit: {e}"))?;
    }
    if let Some(limit) = direct_u64(opts, "lowSpeedLimitBytes").filter(|v| *v > 0) {
        easy.low_speed_limit(limit.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure low-speed limit: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "speedTimeSec").filter(|v| *v > 0) {
        easy.low_speed_time(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure low-speed time: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "timeoutSec").filter(|v| *v > 0) {
        easy.timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure timeout: {e}"))?;
    }
    if let Some(sec) = direct_u64(opts, "connectTimeoutSec").filter(|v| *v > 0) {
        easy.connect_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure connect timeout: {e}"))?;
    }
    if let Some(max) = direct_u64(opts, "maxRedirs") {
        easy.max_redirections(max.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure redirect limit: {e}"))?;
    }
    // ── Default stall/connect guards ──
    // Without these a connection to a slow or rate-limiting CDN/mirror (common
    // with Google, VideoLAN, SourceForge) that accepts the socket but never
    // sends data hangs forever with 0% progress. Abort such connections so the
    // retry policy can recover instead of the task stalling indefinitely. Only
    // applied when the user hasn't set their own values.
    if direct_u64(opts, "connectTimeoutSec").is_none() {
        let _ = easy.connect_timeout(Duration::from_secs(30));
    }
    if direct_u64(opts, "lowSpeedLimitBytes").is_none()
        && direct_u64(opts, "speedTimeSec").is_none()
    {
        let _ = easy.low_speed_limit(1);
        let _ = easy.low_speed_time(Duration::from_secs(45));
    }
    // ── Authentication ──
    if let Some(user) = direct_str(opts, "username") {
        easy.username(user)
            .map_err(|e| format!("Could not configure username: {e}"))?;
    }
    if let Some(pass) = direct_str(opts, "password") {
        easy.password(pass)
            .map_err(|e| format!("Could not configure password: {e}"))?;
    }
    if let Some(auth_type) = direct_str(opts, "authType") {
        let mut auth = Auth::new();
        let lower = auth_type.to_ascii_lowercase();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" => {
                auth.auto(true);
            }
            _ => {
                auth.basic(true);
            }
        }
        easy.http_auth(&auth)
            .map_err(|e| format!("Could not configure HTTP auth: {e}"))?;
    }
    // ── Netrc ──
    if let Some(netrc_val) = direct_str(opts, "netrc") {
        let lower = netrc_val.to_ascii_lowercase();
        match lower.as_str() {
            "optional" | "yes" => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "required" | "true" | "on" => easy
                .netrc(NetRc::Required)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "no" | "false" | "off" | "ignored" => easy
                .netrc(NetRc::Ignored)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            _ => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
        }
    }
    if direct_bool(opts, "netrcOptional") == Some(true) {
        easy.netrc(NetRc::Optional)
            .map_err(|e| format!("Could not configure netrc-optional: {e}"))?;
    }
    // ── Client certificates (mTLS) ──
    if let Some(cert) = direct_str(opts, "cert") {
        easy.ssl_cert(cert)
            .map_err(|e| format!("Could not configure SSL certificate: {e}"))?;
    }
    if let Some(cert_type) = direct_str(opts, "certType") {
        easy.ssl_cert_type(cert_type)
            .map_err(|e| format!("Could not configure certificate type: {e}"))?;
    }
    if let Some(key) = direct_str(opts, "key") {
        easy.ssl_key(key)
            .map_err(|e| format!("Could not configure SSL key: {e}"))?;
    }
    if let Some(key_type) = direct_str(opts, "keyType") {
        easy.ssl_key_type(key_type)
            .map_err(|e| format!("Could not configure key type: {e}"))?;
    }
    if let Some(key_pass) = direct_str(opts, "pass") {
        easy.key_password(key_pass)
            .map_err(|e| format!("Could not configure key password: {e}"))?;
    }
    // ── TLS version and cipher configuration ──
    if let Some(ciphers) = direct_str(opts, "ciphers") {
        easy.ssl_cipher_list(ciphers)
            .map_err(|e| format!("Could not configure TLS cipher list: {e}"))?;
    }
    if let Some(tls_max) = direct_str(opts, "tlsMax") {
        let lower = tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure TLS max version: {e}"))?;
        }
    }
    // CA path (directory of CA certs)
    if let Some(ca_path) = direct_str(opts, "caPath") {
        easy.capath(ca_path)
            .map_err(|e| format!("Could not configure CA path: {e}"))?;
    }
    if direct_bool(opts, "sslReqd") == Some(true) {
        easy.ssl_verify_peer(true)
            .map_err(|e| format!("Could not enable SSL peer verification: {e}"))?;
        easy.ssl_verify_host(true)
            .map_err(|e| format!("Could not enable SSL host verification: {e}"))?;
    }
    // ── Proxy authentication ──
    if let Some(proxy_user) = direct_str(opts, "proxyUser") {
        if let Some(proxy_pass) = direct_str(opts, "proxyPassword") {
            let cred = format!("{}:{}", proxy_user, proxy_pass);
            easy.proxy_username(&cred)
                .map_err(|e| format!("Could not configure proxy credentials: {e}"))?;
        } else {
            easy.proxy_username(proxy_user)
                .map_err(|e| format!("Could not configure proxy username: {e}"))?;
        }
    }
    if let Some(proxy_auth_val) = direct_str(opts, "proxyAnyAuth") {
        let lower = proxy_auth_val.to_ascii_lowercase();
        let mut auth = Auth::new();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" | "auto" => {
                auth.auto(true);
            }
            _ => {
                auth.auto(true);
            }
        }
        easy.proxy_auth(&auth)
            .map_err(|e| format!("Could not configure proxy auth: {e}"))?;
    }
    // ── FTP options ──
    // Note: ftpCreateDirs is handled via CLI args (curl binary), not libcurl Easy2 API
    // ── Protocol and transfer options ──
    if direct_bool(opts, "remoteTime") == Some(true) {
        easy.fetch_filetime(true)
            .map_err(|e| format!("Could not enable remote time fetch: {e}"))?;
    }
    if let Some(method) = direct_str(opts, "requestMethod") {
        easy.custom_request(method)
            .map_err(|e| format!("Could not configure custom request method: {e}"))?;
    }
    if let Some(post_data) = direct_str(opts, "data") {
        easy.post_fields_copy(post_data.as_bytes())
            .map_err(|e| format!("Could not configure POST data: {e}"))?;
    }
    // ── Time conditions (If-Modified-Since / If-Unmodified-Since) ──
    if let Some(time_cond) = direct_str(opts, "timeCond") {
        let lower = time_cond.to_ascii_lowercase();
        let cond = match lower.as_str() {
            "if-modified-since" | "modified" => Some(TimeCondition::IfModifiedSince),
            "if-unmodified-since" | "unmodified" => Some(TimeCondition::IfUnmodifiedSince),
            _ => None,
        };
        if let Some(c) = cond {
            easy.time_condition(c)
                .map_err(|e| format!("Could not configure time condition: {e}"))?;
            if let Some(ts) = direct_u64(opts, "timeValue") {
                easy.time_value(ts as i64)
                    .map_err(|e| format!("Could not configure time value: {e}"))?;
            }
        }
    }
    // ── TCP tuning ──
    if direct_bool(opts, "tcpNoDelay") == Some(true) {
        easy.tcp_nodelay(true)
            .map_err(|e| format!("Could not enable TCP no-delay: {e}"))?;
    }
    if direct_bool(opts, "pathAsIs") == Some(true) {
        easy.path_as_is(true)
            .map_err(|e| format!("Could not enable path-as-is: {e}"))?;
    }
    if let Some(keepalive_sec) = direct_u64(opts, "keepaliveTimeSec").filter(|v| *v > 0) {
        let dur = Duration::from_secs(keepalive_sec);
        easy.tcp_keepidle(dur)
            .map_err(|e| format!("Could not configure keepalive idle time: {e}"))?;
        easy.tcp_keepintvl(dur)
            .map_err(|e| format!("Could not configure keepalive interval: {e}"))?;
    }
    // ── DNS resolve overrides ──
    let resolve_entries = direct_array(opts, "resolve");
    if !resolve_entries.is_empty() {
        let mut list = List::new();
        for entry in &resolve_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add DNS resolve entry: {e}"))?;
        }
        easy.resolve(list)
            .map_err(|e| format!("Could not configure DNS resolve overrides: {e}"))?;
    }
    let connect_to_entries = direct_array(opts, "connectTo");
    if !connect_to_entries.is_empty() {
        let mut list = List::new();
        for entry in &connect_to_entries {
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add connect-to entry: {e}"))?;
        }
        easy.connect_to(list)
            .map_err(|e| format!("Could not configure connect-to overrides: {e}"))?;
    }
    // ── Connection pool tuning ──
    if let Some(max_connects) = direct_u64(opts, "maxConnects").filter(|v| *v > 0) {
        easy.max_connects(max_connects.min(u32::MAX as u64) as u32)
            .map_err(|e| format!("Could not configure max connects: {e}"))?;
    }
    match direct_str(opts, "httpVersion")
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "1.0" | "http1.0" => easy
            .http_version(HttpVersion::V10)
            .map_err(|e| format!("Could not force HTTP/1.0: {e}"))?,
        "1.1" | "http1.1" => easy
            .http_version(HttpVersion::V11)
            .map_err(|e| format!("Could not force HTTP/1.1: {e}"))?,
        "2" | "http2" => easy
            .http_version(HttpVersion::V2)
            .map_err(|e| format!("Could not force HTTP/2: {e}"))?,
        "2-prior-knowledge" | "http2-prior-knowledge" => easy
            .http_version(HttpVersion::V2PriorKnowledge)
            .map_err(|e| format!("Could not force HTTP/2 prior knowledge: {e}"))?,
        "3" | "http3" => easy
            .http_version(HttpVersion::V3)
            .map_err(|e| format!("Could not force HTTP/3: {e}"))?,
        _ => {}
    }
    // ── IP version resolution ──
    if let Some(ip) = direct_str(opts, "ipResolve") {
        let lower = ip.to_ascii_lowercase();
        match lower.as_str() {
            "4" | "ipv4" | "4-only" => easy
                .ip_resolve(IpResolve::V4)
                .map_err(|e| format!("Could not force IPv4: {e}"))?,
            "6" | "ipv6" | "6-only" => easy
                .ip_resolve(IpResolve::V6)
                .map_err(|e| format!("Could not force IPv6: {e}"))?,
            _ => {}
        }
    }
    // ── TLS minimum version ──
    if let Some(tls_min) = direct_str(opts, "tlsMin") {
        let lower = tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure TLS min version: {e}"))?;
        }
    }
    // ── TLS version range (tlsMin + tlsMax together) ──
    if let (Some(tls_min), Some(tls_max)) = (direct_str(opts, "tlsMin"), direct_str(opts, "tlsMax"))
    {
        let parse_ver = |s: &str| -> Option<SslVersion> {
            let l = s.to_ascii_lowercase();
            match l.as_str() {
                "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
                "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
                "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
                "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
                _ => None,
            }
        };
        if let (Some(min_v), Some(max_v)) = (parse_ver(tls_min), parse_ver(tls_max)) {
            easy.ssl_min_max_version(min_v, max_v)
                .map_err(|e| format!("Could not configure TLS version range: {e}"))?;
        }
    }
    // ── SSL options (behavior flags) ──
    if let Some(opts_str) = direct_str(opts, "sslOptions") {
        let mut ssl_opt = SslOpt::new();
        let lower = opts_str.to_ascii_lowercase();
        if lower.contains("no-revoke") {
            ssl_opt.no_revoke(true);
        }
        if lower.contains("no-partial") {
            ssl_opt.no_partial_chain(true);
        }
        if lower.contains("native-ca") {
            ssl_opt.native_ca(true);
        }
        if lower.contains("auto-client-cert") {
            ssl_opt.auto_client_cert(true);
        }
        easy.ssl_options(&ssl_opt)
            .map_err(|e| format!("Could not configure SSL options: {e}"))?;
    }
    // ── Certificate Revocation List ──
    if let Some(crl) = direct_str(opts, "crlFile") {
        easy.crlfile(crl)
            .map_err(|e| format!("Could not configure CRL file: {e}"))?;
    }
    // ── Issuer certificate ──
    if let Some(issuer) = direct_str(opts, "issuerCert") {
        easy.issuer_cert(issuer)
            .map_err(|e| format!("Could not configure issuer certificate: {e}"))?;
    }
    // ── SSL session ID cache ──
    if direct_bool(opts, "sslSessionIdCache") == Some(false) {
        easy.ssl_sessionid_cache(false)
            .map_err(|e| format!("Could not disable SSL session ID cache: {e}"))?;
    }
    // ── Proxy TLS configuration ──
    if let Some(proxy_cainfo) = direct_str(opts, "proxyCaInfo") {
        easy.proxy_cainfo(proxy_cainfo)
            .map_err(|e| format!("Could not configure proxy CA info: {e}"))?;
    }
    if let Some(proxy_capath) = direct_str(opts, "proxyCaPath") {
        easy.proxy_capath(proxy_capath)
            .map_err(|e| format!("Could not configure proxy CA path: {e}"))?;
    }
    if let Some(proxy_cert) = direct_str(opts, "proxyCert") {
        easy.proxy_sslcert(proxy_cert)
            .map_err(|e| format!("Could not configure proxy SSL cert: {e}"))?;
    }
    if let Some(proxy_cert_type) = direct_str(opts, "proxyCertType") {
        easy.proxy_sslcert_type(proxy_cert_type)
            .map_err(|e| format!("Could not configure proxy cert type: {e}"))?;
    }
    if let Some(proxy_key) = direct_str(opts, "proxyKey") {
        easy.proxy_sslkey(proxy_key)
            .map_err(|e| format!("Could not configure proxy SSL key: {e}"))?;
    }
    if let Some(proxy_key_type) = direct_str(opts, "proxyKeyType") {
        easy.proxy_sslkey_type(proxy_key_type)
            .map_err(|e| format!("Could not configure proxy key type: {e}"))?;
    }
    if let Some(proxy_key_pass) = direct_str(opts, "proxyKeyPassword") {
        easy.proxy_key_password(proxy_key_pass)
            .map_err(|e| format!("Could not configure proxy key password: {e}"))?;
    }
    if let Some(proxy_cipher) = direct_str(opts, "proxyCiphers") {
        easy.proxy_ssl_cipher_list(proxy_cipher)
            .map_err(|e| format!("Could not configure proxy cipher list: {e}"))?;
    }
    if let Some(proxy_tls_max) = direct_str(opts, "proxyTlsMax") {
        let lower = proxy_tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.proxy_ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure proxy TLS max version: {e}"))?;
        }
    }
    if let Some(proxy_tls_min) = direct_str(opts, "proxyTlsMin") {
        let lower = proxy_tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.proxy_ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure proxy TLS min version: {e}"))?;
        }
    }
    if direct_bool(opts, "proxyVerifyPeer") == Some(false) {
        easy.proxy_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable proxy peer verification: {e}"))?;
    }
    if direct_bool(opts, "proxyVerifyHost") == Some(false) {
        easy.proxy_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable proxy host verification: {e}"))?;
    }
    // ── Proxy type ──
    if let Some(proxy_type_val) = direct_str(opts, "proxyType") {
        let lower = proxy_type_val.to_ascii_lowercase();
        let pt = match lower.as_str() {
            "socks4" => Some(ProxyType::Socks4),
            "socks5" => Some(ProxyType::Socks5),
            "socks4a" => Some(ProxyType::Socks4a),
            "socks5h" => Some(ProxyType::Socks5Hostname),
            _ => None,
        };
        if let Some(pt_val) = pt {
            easy.proxy_type(pt_val)
                .map_err(|e| format!("Could not configure proxy type: {e}"))?;
        }
    }
    // ── Proxy tunnel (HTTP CONNECT) ──
    if direct_bool(opts, "proxyTunnel") == Some(true) {
        easy.http_proxy_tunnel(true)
            .map_err(|e| format!("Could not enable proxy tunnel: {e}"))?;
    }
    // ── Unrestricted auth on redirects ──
    if direct_bool(opts, "unrestrictedAuth") == Some(true) {
        easy.unrestricted_auth(true)
            .map_err(|e| format!("Could not enable unrestricted auth: {e}"))?;
    }
    // ── HTTP transfer encoding ──
    if direct_bool(opts, "transferEncoding") == Some(true) {
        easy.transfer_encoding(true)
            .map_err(|e| format!("Could not enable transfer encoding: {e}"))?;
    }
    // ── HTTP 0.9 allowed ──
    if direct_bool(opts, "http09Allowed") == Some(true) {
        easy.http_09_allowed(true)
            .map_err(|e| format!("Could not enable HTTP/0.9: {e}"))?;
    }
    // ── Expect 100-continue timeout ──
    if let Some(timeout) = direct_u64(opts, "expect100TimeoutMs") {
        easy.expect_100_timeout(Duration::from_millis(timeout))
            .map_err(|e| format!("Could not configure expect-100 timeout: {e}"))?;
    }
    // ── Fresh connection (bypass connection pool) ──
    if direct_bool(opts, "freshConnect") == Some(true) {
        easy.fresh_connect(true)
            .map_err(|e| format!("Could not force fresh connection: {e}"))?;
    }
    // ── Forbid connection reuse ──
    if direct_bool(opts, "forbidReuse") == Some(true) {
        easy.forbid_reuse(true)
            .map_err(|e| format!("Could not forbid connection reuse: {e}"))?;
    }
    // ── Max connection age ──
    if let Some(age) = direct_u64(opts, "maxAgeConn") {
        easy.maxage_conn(Duration::from_secs(age))
            .map_err(|e| format!("Could not configure max connection age: {e}"))?;
    }
    // ── Local port / port range ──
    if let Some(range) = direct_str(opts, "localPortRange") {
        if let Some((start, _end)) = range.split_once('-') {
            if let Ok(s) = start.trim().parse::<u16>() {
                easy.local_port_range(s)
                    .map_err(|err| format!("Could not configure local port range: {err}"))?;
            }
        }
    }
    // ── DoH TLS verification ──
    if direct_bool(opts, "dohSslVerifyPeer") == Some(false) {
        easy.doh_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable DoH peer verification: {e}"))?;
    }
    if direct_bool(opts, "dohSslVerifyHost") == Some(false) {
        easy.doh_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable DoH host verification: {e}"))?;
    }
    // Build the full header list:
    // Always inject browser-like base headers unless the caller provides custom ones.
    let custom_headers = direct_headers(opts)?;
    let has_custom = custom_headers.is_some();
    if !has_custom {
        // Send headers that mimic a real browser so CDNs / mirrors (e.g. videolan.org)
        // don't 403 or redirect to a HTML page instead of the binary.
        let mut list = ::curl::easy::List::new();
        list.append("Accept: */*")
            .map_err(|e| format!("Could not add Accept header: {e}"))?;
        list.append("Accept-Language: en-US,en;q=0.9")
            .map_err(|e| format!("Could not add Accept-Language header: {e}"))?;
        list.append("Cache-Control: no-cache")
            .map_err(|e| format!("Could not add Cache-Control header: {e}"))?;
        list.append("Connection: keep-alive")
            .map_err(|e| format!("Could not add Connection header: {e}"))?;
        if let Some(bearer) = direct_str(opts, "oauth2Bearer") {
            list.append(&format!("Authorization: Bearer {}", bearer))
                .map_err(|e| format!("Could not add OAuth2 bearer header: {e}"))?;
        }
        easy.http_headers(list)
            .map_err(|e| format!("Could not configure default headers: {e}"))?;
    } else if let Some(headers) = custom_headers {
        easy.http_headers(headers)
            .map_err(|e| format!("Could not configure headers: {e}"))?;
    }
    Ok(())
}

fn create_easy_for_range(
    plan: &DirectDownloadPlan,
    path: &Path,
    progress: SegmentProgress,
    range: Option<(u64, u64)>,
    bandwidth_limit: Option<u64>,
) -> Result<Easy2<SegmentWriter>, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create segment folder: {e}"))?;
        }
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("Could not open segment output file: {e}"))?;
    let mut easy = Easy2::new(SegmentWriter { file, progress });
    apply_easy_options(&mut easy, plan, range)?;
    if let Some(limit) = bandwidth_limit.filter(|l| *l > 0) {
        let _ = easy.max_recv_speed(limit);
    }
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

    let speed_u64 = speed.max(0.0) as u64;

    state.bandwidth_manager.report_speed(id, speed_u64);

    if let Ok(trackers) = state.engine_trackers.lock() {
        if let Some(tracker) = trackers.get(id) {
            tracker.adaptive.report_speed(speed_u64);
        }
    }

    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        job.task.downloaded_bytes = downloaded;
        job.task.size_bytes = total_size;
        job.task.speed_bytes_per_sec = speed.max(0.0) as u64;
        job.task.elapsed_seconds = job.start_time.elapsed().as_secs();
        job.task.time_left_seconds = if speed > 0.0 && total_size > downloaded {
            ((total_size - downloaded) as f64 / speed).ceil() as u64
        } else {
            0
        };
        if job.segment_prev_bytes.len() != ranges.len() {
            job.segment_prev_bytes.resize(ranges.len(), 0);
        }
        let mut segment_speeds: Vec<u64> = Vec::with_capacity(ranges.len());
        for (i, (range, _)) in ranges.iter().enumerate() {
            let seg_total = part_size(range);
            let seg_downloaded = current_file_size(&range.path).min(seg_total);
            let prev = job.segment_prev_bytes[i];
            let seg_speed = if seg_downloaded > prev {
                (seg_downloaded - prev) as f64 / elapsed
            } else {
                0.0
            };
            job.segment_prev_bytes[i] = seg_downloaded;
            segment_speeds.push(seg_speed.max(0.0) as u64);
        }
        job.task.segments = ranges
            .iter()
            .enumerate()
            .map(|(i, (range, _progress))| {
                let seg_total = part_size(range);
                let seg_downloaded = current_file_size(&range.path).min(seg_total);
                Segment {
                    id: range.index as u32,
                    progress: if seg_total > 0 {
                        seg_downloaded as f64 / seg_total as f64
                    } else {
                        0.0
                    },
                    downloaded_bytes: seg_downloaded,
                    total_bytes: seg_total,
                    active: seg_downloaded < seg_total && job.task.status == "downloading",
                    speed: segment_speeds[i],
                }
            })
            .collect();
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn update_single_progress(
    state: &SharedState,
    id: &str,
    path: &Path,
    total_size: u64,
    last_total: &mut u64,
    last_tick: &mut Instant,
) {
    let downloaded = current_file_size(path);
    let now = Instant::now();
    let elapsed = now.duration_since(*last_tick).as_secs_f64().max(0.001);
    let speed = downloaded.saturating_sub(*last_total) as f64 / elapsed;
    *last_total = downloaded;
    *last_tick = now;

    let speed_u64 = speed.max(0.0) as u64;

    state.bandwidth_manager.report_speed(id, speed_u64);

    if let Ok(trackers) = state.engine_trackers.lock() {
        if let Some(tracker) = trackers.get(id) {
            tracker.adaptive.report_speed(speed_u64);
        }
    }

    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        job.task.downloaded_bytes = downloaded;
        if total_size > 0 {
            job.task.size_bytes = total_size;
        }
        job.task.speed_bytes_per_sec = speed.max(0.0) as u64;
        job.task.elapsed_seconds = job.start_time.elapsed().as_secs();
        job.task.time_left_seconds = if speed > 0.0 && job.task.size_bytes > downloaded {
            ((job.task.size_bytes - downloaded) as f64 / speed).ceil() as u64
        } else {
            0
        };
        job.task.segments = build_segments(
            1,
            job.task.size_bytes,
            downloaded,
            true,
            job.task.speed_bytes_per_sec,
        );
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn run_single_libcurl(
    state: &SharedState,
    id: &str,
    plan: &DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    ensure_parent(&plan.output_path)?;
    if direct_bool(&plan.direct_options, "skipExisting") == Some(true) && plan.output_path.exists()
    {
        let existing = current_file_size(&plan.output_path);
        return Ok(existing);
    }
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
        } else if !plan.resumable && existing > 0 {
            if !plan.allow_overwrite {
                return Err(format!(
                    "Destination already exists: {}",
                    plan.output_path.display()
                ));
            }
            let _ = std::fs::remove_file(&plan.output_path);
        } else if !plan.allow_overwrite && plan.total_size == 0 && existing > 0 {
            return Err(format!(
                "Cannot safely resume existing destination without a known remote size: {}",
                plan.output_path.display()
            ));
        }
    }

    let progress = SegmentProgress {
        downloaded: Arc::new(AtomicU64::new(0)),
        abort: cancel.clone(),
    };
    let task_limit = state.bandwidth_manager.allowed_speed_for_task(id);
    let task_limit_bps = if task_limit > 0 {
        Some(task_limit * 1024)
    } else {
        None
    };
    let easy = create_easy_for_range(plan, &plan.output_path, progress, None, task_limit_bps)?;
    let mut multi = Multi::new();
    configure_multi_limits(
        &mut multi,
        ConnectionLimits::from_options(&plan.direct_options, 1, MAX_DIRECT_CONNECTIONS),
    )?;
    let mut socket_runtime = if matches!(
        EventLoopMode::from_options(&plan.direct_options),
        EventLoopMode::MultiSocket
    ) {
        Some(MultiSocketRuntime::attach(&mut multi)?)
    } else {
        None
    };
    let handle = multi
        .add2(easy)
        .map_err(|e| format!("Could not add transfer to libcurl multi: {e}"))?;
    let handles = vec![handle];
    let mut last_total = current_file_size(&plan.output_path);
    let mut last_tick = Instant::now();
    let mut tick = || {
        update_single_progress(
            state,
            id,
            &plan.output_path,
            plan.total_size,
            &mut last_total,
            &mut last_tick,
        )
    };
    if let Some(runtime) = socket_runtime.as_mut() {
        drive_multi_socket(&multi, runtime, &handles, &cancel, "transfer", &mut tick)?;
    } else {
        drive_multi_wait_perform(&multi, &handles, &cancel, "transfer", &mut tick)?;
    }
    let response = handles[0]
        .response_code()
        .map_err(|e| format!("Could not read HTTP response code: {e}"))?;
    if response >= 400 {
        return Err(format!("HTTP error {}", response));
    }
    Ok(current_file_size(&plan.output_path))
}

fn run_segmented_libcurl(
    state: &SharedState,
    id: &str,
    plan: &DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    ensure_parent(&plan.output_path)?;
    if !plan.allow_overwrite && plan.output_path.exists() {
        let existing = current_file_size(&plan.output_path);
        if existing == plan.total_size && plan.total_size > 0 {
            return Ok(existing);
        }
        return Err(format!(
            "Destination already exists: {}",
            plan.output_path.display()
        ));
    }
    if !plan.resumable {
        let _ = std::fs::remove_file(&plan.output_path);
        remove_stale_parts_for(&plan.output_path);
    }
    if plan.output_path.exists()
        && current_file_size(&plan.output_path) == plan.total_size
        && plan.total_size > 0
    {
        return Ok(plan.total_size);
    }

    let ranges = split_ranges(plan.total_size, plan.connections, &plan.output_path);

    let segment_scheduler = crate::daemon::engine::dynamic_segments::DynamicSegmentScheduler::new(
        plan.total_size,
        plan.connections,
        MAX_DIRECT_CONNECTIONS,
    );

    {
        let mut trackers = lock_or_err!(state.engine_trackers);
        trackers.insert(
            id.to_string(),
            crate::daemon::state::TaskEngineTracker {
                adaptive:
                    crate::daemon::engine::adaptive_connections::AdaptiveConnectionManager::new(
                        plan.connections,
                        Default::default(),
                    ),
                segments: Some(segment_scheduler.clone()),
                retry_state: crate::daemon::engine::retry::RetryState::new(),
            },
        );
    }

    let mut active: Vec<(ByteRange, Arc<AtomicU64>)> = Vec::new();
    let mut multi = Multi::new();
    configure_multi_limits(
        &mut multi,
        ConnectionLimits::from_options(
            &plan.direct_options,
            plan.connections,
            MAX_DIRECT_CONNECTIONS,
        ),
    )?;
    multi
        .pipelining(false, true)
        .map_err(|e| format!("Could not enable libcurl multiplexing: {e}"))?;
    let mut socket_runtime = if matches!(
        EventLoopMode::from_options(&plan.direct_options),
        EventLoopMode::MultiSocket
    ) {
        Some(MultiSocketRuntime::attach(&mut multi)?)
    } else {
        None
    };

    let mut handles = Vec::new();
    let task_limit = state.bandwidth_manager.allowed_speed_for_task(id);
    let per_segment_limit_bps = if task_limit > 0 {
        Some((task_limit * 1024) / plan.connections.max(1) as u64)
    } else {
        None
    };
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
            SegmentProgress {
                downloaded: progress.clone(),
                abort: cancel.clone(),
            },
            Some((start, range.end)),
            per_segment_limit_bps,
        )?;
        let handle = multi
            .add2(easy)
            .map_err(|e| format!("Could not add segment {}: {e}", range.index))?;
        handles.push(handle);
        active.push((range, progress));
    }

    if handles.is_empty() {
        return merge_parts(&plan.output_path, &ranges);
    }

    let mut last_total: u64 = active
        .iter()
        .map(|(r, _p)| current_file_size(&r.path).min(part_size(r)))
        .sum();
    let mut last_tick = Instant::now();
    let mut prev_seg_bytes: Vec<u64> = vec![0; active.len()];
    let mut tick = || {
        let now = Instant::now();
        let elapsed = now.duration_since(last_tick).as_secs_f64().max(0.001);
        for (i, (_range, progress)) in active.iter().enumerate() {
            let seg_downloaded = progress.load(Ordering::Relaxed);
            let seg_speed = if seg_downloaded > prev_seg_bytes[i] {
                ((seg_downloaded - prev_seg_bytes[i]) as f64 / elapsed) as u64
            } else {
                0
            };
            prev_seg_bytes[i] = seg_downloaded;
            segment_scheduler.update_segment(i as u32, seg_downloaded, seg_speed, true);
        }
        if let Ok(trackers) = state.engine_trackers.lock() {
            if let Some(tracker) = trackers.get(id) {
                if let Some(adj) = tracker.adaptive.should_adjust() {
                    log::debug!(
                        "Adaptive suggestion for task {}: {} -> {} ({})",
                        id,
                        adj.old_count,
                        adj.new_count,
                        adj.reason
                    );
                    tracker.adaptive.apply_adjustment(&adj);
                }
            }
        }
        update_curl_task_progress(
            state,
            id,
            plan.total_size,
            &active,
            &mut last_total,
            &mut last_tick,
        )
    };
    if let Some(runtime) = socket_runtime.as_mut() {
        drive_multi_socket(&multi, runtime, &handles, &cancel, "segment", &mut tick)?;
    } else {
        drive_multi_wait_perform(&multi, &handles, &cancel, "segment", &mut tick)?;
    }
    for (idx, handle) in handles.iter().enumerate() {
        let code = handle
            .response_code()
            .map_err(|e| format!("Segment {idx}: could not read HTTP response code: {e}"))?;
        if code != 206 && code != 200 {
            return Err(format!(
                "Segment {} finished with unexpected HTTP status {}",
                idx, code
            ));
        }
        if code == 200 && plan.connections > 1 {
            return Err("Server did not honor byte-range requests; retry with one connection or probe the URL again.".to_string());
        }
    }
    update_curl_task_progress(
        state,
        id,
        plan.total_size,
        &active,
        &mut last_total,
        &mut last_tick,
    );
    merge_parts(&plan.output_path, &ranges)
}

fn run_libcurl_download(
    state: &SharedState,
    id: &str,
    mut plan: DirectDownloadPlan,
    cancel: Arc<AtomicBool>,
) -> Result<u64, String> {
    let retry_policy = RetryPolicy::from_options(&plan.direct_options);
    let integrity = IntegrityValidator::new(IntegrityMetadata::from_expected_size(plan.total_size));
    let start_time = std::time::Instant::now();
    let mut last_error = String::new();
    let started_segmented = plan.segmented;
    for attempt in 0..retry_policy.attempts {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".to_string());
        }
        if let Some(max_time) = retry_policy.max_total_time {
            if start_time.elapsed() >= max_time {
                break;
            }
        }
        let result = if plan.segmented {
            run_segmented_libcurl(state, id, &plan, cancel.clone())
        } else {
            run_single_libcurl(state, id, &plan, cancel.clone())
        };
        match result {
            Ok(size) => {
                if let Ok(mut trackers) = state.engine_trackers.lock() {
                    if let Some(tracker) = trackers.get_mut(id) {
                        tracker.retry_state.reset();
                    }
                }
                if let Ok(managers) = state.mirror_managers.lock() {
                    if let Some(mgr) = managers.get(id) {
                        mgr.report_success(&plan.url);
                    }
                }
                integrity.validate_size(size)?;
                return Ok(size);
            }
            Err(error) if error == "cancelled" || cancel.load(Ordering::Acquire) => {
                return Err("cancelled".to_string())
            }
            Err(error) => {
                if let Ok(mut trackers) = state.engine_trackers.lock() {
                    if let Some(tracker) = trackers.get_mut(id) {
                        tracker.retry_state.record_failure(error.clone());
                    }
                }
                if let Ok(managers) = state.mirror_managers.lock() {
                    if let Some(mgr) = managers.get(id) {
                        if let Some(new_url) = mgr.report_failure(&plan.url, &error) {
                            log::info!(
                                "Mirror failover for task {}: {} -> {}",
                                id,
                                plan.url,
                                new_url
                            );
                        }
                    }
                }
                if RetryPolicy::is_permanent_error(&error)
                    || !retry_policy.should_retry_error(&error)
                {
                    return Err(error);
                }
                last_error = error;
                if attempt + 1 < retry_policy.attempts {
                    let backoff_delay = retry_policy.delay_for_attempt(attempt as u32 + 1);
                    if let Some(max_time) = retry_policy.max_total_time {
                        let remaining = max_time.saturating_sub(start_time.elapsed());
                        std::thread::sleep(backoff_delay.min(remaining));
                    } else {
                        std::thread::sleep(backoff_delay);
                    }
                }
            }
        }
    }
    // Guaranteed single-connection fallback: some hosts (Google, VideoLAN and
    // SourceForge mirrors) accept only one range connection and stall the rest,
    // so a segmented download that never succeeded gets one final single-stream
    // attempt regardless of the configured retry count.
    if started_segmented && !cancel.load(Ordering::Acquire) {
        log::info!(
            "Segmented download failed for task {}; final single-connection attempt",
            id
        );
        plan.segmented = false;
        match run_single_libcurl(state, id, &plan, cancel.clone()) {
            Ok(size) => {
                integrity.validate_size(size)?;
                return Ok(size);
            }
            Err(error) if error == "cancelled" || cancel.load(Ordering::Acquire) => {
                return Err("cancelled".to_string());
            }
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn mark_curl_task_finished(state: &SharedState, id: &str, final_size: u64, generation: u64) {
    state.priority_queue.stop_download(id);
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
        job.task.segments = build_segments(
            job.task.connections,
            job.task.size_bytes,
            final_size,
            false,
            0,
        );
        let task = job.task.clone();
        drop(jobs);
        lock_or_err!(state.task_snapshot).insert(id.to_string(), task);
        state.mark_dirty();
    }
}

fn mark_curl_task_failed(
    state: &SharedState,
    id: &str,
    message: String,
    cancelled: bool,
    generation: u64,
) {
    if !cancelled {
        state.priority_queue.stop_download(id);
    }
    let mut jobs = lock_or_err!(state.curl_jobs);
    if let Some(job) = jobs.get_mut(id) {
        if job.run_generation.load(Ordering::Relaxed) != generation {
            return;
        }
        job.task.status = if cancelled { "paused" } else { "error" }.to_string();
        job.task.speed_bytes_per_sec = 0;
        job.task.time_left_seconds = 0;
        job.task.engine_status = Some(if cancelled { "paused" } else { "failed" }.to_string());
        job.task.error_message = if cancelled { None } else { Some(message) };
        let task = job.task.clone();
        let remove_on_error = job
            .direct_options
            .get("removeOnError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
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
        let Some(job) = jobs.get_mut(id) else {
            return;
        };
        if job.task.status == "completed" {
            return;
        }
        let worker_was_started = job.run_generation.load(Ordering::Acquire) > 0;
        if worker_was_started
            && matches!(
                job.task.status.as_str(),
                "downloading" | "pausing" | "stopping"
            )
        {
            return;
        }
        job.cancel_token = Arc::new(AtomicBool::new(false));
        let generation = job
            .run_generation
            .fetch_add(1, Ordering::Release)
            .saturating_add(1);
        job.task.status = "downloading".to_string();
        job.task.engine_status = Some("running-libcurl-multi".to_string());
        job.task.error_message = None;
        let plan = plan_from_job(job);
        let token = job.cancel_token.clone();
        (plan, token, generation)
    };
    state.mark_dirty();
    state.priority_queue.start_download(id);

    let state2 = state.clone();
    let id2 = id.to_string();
    std::thread::spawn(move || {
        let (plan, cancel, generation) = record;
        log::info!(
            "Starting libcurl multi transfer for task {} generation {}",
            id2,
            generation
        );
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

const MAX_TASKS: usize = 10_000;

pub async fn create_curl_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, String> {
    let url = body.url.as_deref().unwrap_or("").trim();
    if url.starts_with("magnet:")
        || url.to_lowercase().ends_with(".torrent")
        || url.contains(".torrent?")
    {
        return Err("Torrent/magnet support requires a dedicated torrent engine; libcurl multi is for direct URL downloads.".to_string());
    }
    let direct_url = DirectUrl::parse(url)?;
    crate::daemon::utils::is_safe_target_url(&direct_url.normalized)?;
    let url = direct_url.normalized.as_str();

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
        &direct_options,
        body.resumable.unwrap_or(true),
    )?;

    // Enforce maximum task limit to prevent memory exhaustion
    if lock_or_err!(state.task_snapshot).len() >= MAX_TASKS {
        return Err("Maximum number of tasks reached. Complete or delete some tasks before creating new ones.".to_string());
    }

    let (name, output_path) = destination_from_body(body, url);
    ensure_parent(&output_path)?;
    let fail_with_body_supported = engine_capabilities::curl_supports_flag("--fail-with-body");
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
    // Fast path: return cached list if generation hasn't changed.
    let current_gen = state
        .task_generation
        .load(std::sync::atomic::Ordering::Acquire);
    if let Ok(cache) = state.task_list_cache.read() {
        if let Some((gen, ref list)) = *cache {
            if gen == current_gen {
                return (**list).clone();
            }
        }
    }

    // Slow path: recompute from source maps.
    let mut tasks: Vec<Task> = lock_or_err!(state.media_jobs)
        .values()
        .map(|j| j.task.clone())
        .collect();
    tasks.extend(
        lock_or_err!(state.curl_jobs)
            .values()
            .map(|j| j.task.clone()),
    );

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
    let result = Arc::new(tasks);
    if let Ok(mut cache) = state.task_list_cache.write() {
        *cache = Some((current_gen, result.clone()));
    }
    (*result).clone()
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
            job.cancel_token.store(true, Ordering::Release);
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
    snapshot
        .get(id)
        .cloned()
        .ok_or_else(|| "Task not found".to_string())
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
            return jobs
                .get(id)
                .map(|j| j.task.clone())
                .ok_or_else(|| "Task not found after resume".to_string());
        }
    }

    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if job.task.status == "completed" {
                return Err(format!(
                    "Cannot resume '{}': download is already completed.",
                    job.task.name
                ));
            }
            if matches!(
                job.task.status.as_str(),
                "downloading" | "pausing" | "stopping"
            ) {
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
            if let Some(pid) = job.child {
                kill_process(pid);
            }
            let path = PathBuf::from(&job.task.save_path);
            let url = job.task.url.clone();
            drop(jobs);
            state.priority_queue.remove(id);
            state.bandwidth_manager.remove_task_limit(id);
            if !url.is_empty() {
                state.metadata_cache.remove(&url);
            }
            if delete_files {
                let _ = std::fs::remove_file(&path);
            }
            lock_or_err!(state.task_snapshot).remove(id);
            lock_or_err!(state.engine_trackers).remove(id);
            state.mark_dirty();
            return Ok(());
        }
    }

    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.remove(id) {
            job.cancel_token.store(true, Ordering::Release);
            job.run_generation.fetch_add(1, Ordering::Release);
            let path = PathBuf::from(&job.task.save_path);
            let url = job.task.url.clone();
            drop(jobs);
            state.priority_queue.remove(id);
            state.bandwidth_manager.remove_task_limit(id);
            if !url.is_empty() {
                state.metadata_cache.remove(&url);
            }
            if delete_files {
                let _ = std::fs::remove_file(&path);
                remove_stale_parts_for(&path);
            }
            lock_or_err!(state.task_snapshot).remove(id);
            lock_or_err!(state.engine_trackers).remove(id);
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

pub fn curl_version() -> String {
    let v = ::curl::Version::get();
    format!("libcurl {}", v.version())
}

// ─── Extractor trait implementation ─────────────────────────────────

use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};

pub struct CurlExtractor;

impl Extractor for CurlExtractor {
    fn id(&self) -> &str {
        "libcurl-multi"
    }

    fn can_handle(&self, url: &str, has_media_options: bool) -> bool {
        if has_media_options {
            return false;
        }
        url.starts_with("http://")
            || url.starts_with("https://")
            || url.starts_with("ftp://")
            || url.starts_with("ftps://")
            || url.starts_with("sftp://")
            || url.starts_with("scp://")
    }

    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError> {
        let url = body.url.as_deref().unwrap_or("").trim();
        if url.is_empty() {
            return Err(ValidateError("Missing url".into()));
        }
        if url.starts_with("magnet:") || url.to_lowercase().ends_with(".torrent") {
            return Err(ValidateError(
                "Torrent/magnet requires a dedicated torrent engine".into(),
            ));
        }
        let direct_options = body.direct_options.clone().unwrap_or_default();
        engine_capabilities::validate_curl_direct_options(
            &direct_options,
            body.resumable.unwrap_or(true),
        )
        .map_err(ValidateError)?;
        Ok(())
    }

    fn engine_status(&self, _state: &SharedState) -> EngineStatus {
        let v = ::curl::Version::get();
        EngineStatus {
            id: "libcurl-multi".to_string(),
            name: "libcurl-multi".to_string(),
            available: true,
            version: Some(v.version().to_string()),
            features: vec![
                "direct-http".to_string(),
                "segmented".to_string(),
                "range-requests".to_string(),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

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
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value)
    }

    #[test]
    fn build_curl_args_applies_direct_settings() {
        let mut direct_options = HashMap::new();
        direct_options.insert(
            "headers".to_string(),
            serde_json::json!("Authorization: Bearer token\nX-Test: yes"),
        );
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
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://example.com/file.bin")
        );
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

    #[derive(Clone)]
    struct MemorySink {
        data: Arc<Mutex<Vec<u8>>>,
    }

    impl Handler for MemorySink {
        fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
            self.data.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
    }

    #[test]
    fn multi_socket_runtime_downloads_local_response() {
        let expected = b"hello multi_socket".to_vec();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_body = expected.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                server_body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(&server_body).unwrap();
        });

        let received = Arc::new(Mutex::new(Vec::new()));
        let mut easy = Easy2::new(MemorySink {
            data: received.clone(),
        });
        easy.url(&format!("http://{addr}/file.bin")).unwrap();
        easy.get(true).unwrap();

        let mut multi = Multi::new();
        let mut runtime = MultiSocketRuntime::attach(&mut multi).unwrap();
        let handle = multi.add2(easy).unwrap();
        let handles = vec![handle];
        let cancel = AtomicBool::new(false);

        drive_multi_socket(&multi, &mut runtime, &handles, &cancel, "transfer", || {}).unwrap();

        assert_eq!(handles[0].response_code().unwrap(), 200);
        assert_eq!(*received.lock().unwrap(), expected);
        server.join().unwrap();
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
