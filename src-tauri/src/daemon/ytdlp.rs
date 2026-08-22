use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use uuid::Uuid;

use crate::daemon::engine_capabilities;
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, MediaJob, Segment, Task};
use crate::daemon::utils::{hide_command_window, now_str, push_arg};
use crate::lock_or_err;

// Only these yt-dlp flags are allowed in user-supplied extra_args.
// Any unknown `--` or `-` flag is rejected.
const ALLOWED_YTDLP_ARGS: &[&str] = &[
    "--limit-rate",
    "-r",
    "--retries",
    "-R",
    "--fragment-retries",
    "--concurrent-fragments",
    "-N",
    "--format-sort",
    "-S",
    "--audio-quality",
    "--proxy",
    "--source-address",
    "--user-agent",
    "-U",
    "--referer",
    "--add-header",
    "--cookies",
    "--cookies-from-browser",
    "--sub-langs",
    "--playlist-items",
    "--remux-video",
    "--ffmpeg-location",
    "--no-playlist",
    "--yes-playlist",
    "--embed-subs",
    "--write-subs",
    "--write-auto-subs",
    "--no-write-subs",
    "--embed-metadata",
    "--no-embed-metadata",
    "--write-thumbnail",
    "--embed-thumbnail",
    "--no-embed-thumbnail",
    "--embed-chapters",
    "--no-embed-chapters",
    "--sponsorblock-mark",
    "--sponsorblock-remove",
    "--no-sponsorblock",
    "--throttled-rate",
    "--sleep-interval",
    "--max-sleep-interval",
    "--sleep-requests",
    "--download-sections",
    "--match-filter",
    "--write-info-json",
    "--no-write-info-json",
    "--write-description",
    "--no-write-description",
    "--write-annotations",
    "--no-write-annotations",
    "--extractor-args",
    "--geo-bypass",
    "--no-geo-bypass",
    "--geo-bypass-country",
    "--geo-bypass-ip-block",
    "--abort-on-error",
    "--no-abort-on-error",
    "--ignore-errors",
    "--no-ignore-errors",
    "--no-overwrites",
    "--continue",
    "--no-continue",
    "--restrict-filenames",
    "--no-restrict-filenames",
    "--windows-filenames",
    "--no-windows-filenames",
    "--trim-filenames",
    "--min-filesize",
    "--max-filesize",
    "-m",
    "-M",
    "--no-download",
    "--simulate",
    "--file-access-retries",
    "--retry-sleep",
    "--buffer-size",
    "--http-chunk-size",
    "--downloader",
    "--external-downloader",
    "--downloader-args",
    "--external-downloader-args",
    "--download-archive",
    "--break-on-existing",
    "--force-overwrites",
    "--no-force-overwrites",
    "--write-comments",
    "--convert-thumbnails",
    "--postprocessor-args",
    "--compat-options",
    "--live-from-start",
    "--wait-for-video",
    "--sleep-subtitles",
    "--socket-timeout",
    "--username",
    "-u",
    "--password",
    "-p",
    "--twofactor",
    "-2",
    "--netrc",
    "--xattrs",
    "--no-mtime",
];

/// Flags that accept a file-system path as their value.
const PATH_VALUE_FLAGS: &[&str] = &[
    "--cookies",
    "--load-info-json",
    "--download-archive",
    "--batch-file",
    "--ffmpeg-location",
];

fn is_safe_extra_arg(arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    // Reject shell metacharacters in any extra arg
    if arg.contains(|c: char| {
        c == ';'
            || c == '|'
            || c == '&'
            || c == '$'
            || c == '`'
            || c == '\n'
            || c == '\r'
            || c == '\0'
    }) {
        return false;
    }
    // Reject path traversal in ALL non-flag args (values for preceding flags like --cookies)
    if !arg.starts_with('-') {
        return !arg.contains("..");
    }
    // For flags, only allow known-safe ones (whitelist approach)
    if let Some(allowed) = ALLOWED_YTDLP_ARGS
        .iter()
        .find(|allowed| arg == **allowed || arg.starts_with(&format!("{allowed}=")))
    {
        // Reject path traversal in flags that accept file paths
        if let Some(value) = arg.strip_prefix(&format!("{allowed}=")) {
            if PATH_VALUE_FLAGS.contains(allowed) && value.contains("..") {
                log::warn!("Rejected path traversal in extra_arg: {arg}");
                return false;
            }
        }
        return true;
    }
    // Short flags like -f, -x, -o are always unsafe in extra_args because they
    // change fundamental download behaviour.
    false
}

pub fn start_ytdlp_process(state: &SharedState, id: &str) {
    let jobs = lock_or_err!(state.media_jobs);
    let record = jobs.get(id).cloned();
    drop(jobs);

    if let Some(job) = record {
        log::info!("Starting yt-dlp process for task {id}");
        let ytdlp_bin = state.ytdlp_binary();
        let mut cmd = Command::new(&ytdlp_bin);
        hide_command_window(&mut cmd);
        match cmd
            .args(&job.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                let child_pid = child.id();
                let state2 = state.clone();
                let id2 = id.to_owned();

                // Read stdout and stderr concurrently to prevent deadlock
                // when the pipe buffer fills (CRITICAL #18).
                let stdout_handle = child.stdout.take().map(|r| {
                    std::thread::spawn({
                        let state2 = state2.clone();
                        let id2 = id2.clone();
                        move || {
                            let _task_ctx = crate::logging::push_context("task", &id2);
                            let _phase_ctx = crate::logging::push_context("phase", "ytdlp-stdout");
                            let reader = BufReader::new(r);
                            for line in reader.lines() {
                                match line {
                                    Ok(line) if !line.is_empty() => {
                                        update_ytdlp_progress(&state2, &id2, &line);
                                    }
                                    Ok(_) => {}
                                    Err(error) => {
                                        log::warn!(
                                            "yt-dlp stdout reader failed for task {id2}: {error}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                    })
                });
                let stderr_handle = child.stderr.take().map(|r| {
                    std::thread::spawn({
                        let id2 = id2.clone();
                        move || {
                            let _task_ctx = crate::logging::push_context("task", &id2);
                            let _phase_ctx = crate::logging::push_context("phase", "ytdlp-stderr");
                            let reader = BufReader::new(r);
                            for line in reader.lines() {
                                match line {
                                    Ok(line) if !line.is_empty() => {
                                        log::debug!("yt-dlp [{id2}]: {line}");
                                    }
                                    Ok(_) => {}
                                    Err(error) => {
                                        log::warn!(
                                            "yt-dlp stderr reader failed for task {id2}: {error}"
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                    })
                });

                std::thread::spawn(move || {
                    let _task_ctx = crate::logging::push_context("task", &id2);
                    let _phase_ctx = crate::logging::push_context("phase", "ytdlp");
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        // The readers drain both pipes concurrently while the
                        // child runs. Wait for process termination first; after
                        // it closes the descriptors, joins cannot block behind a
                        // still-running producer.
                        let status = match child.wait() {
                            Ok(status) => Some(status),
                            Err(error) => {
                                log::error!("Could not wait for yt-dlp task {id2}: {error}");
                                None
                            }
                        };
                        if let Some(h) = stdout_handle {
                            if h.join().is_err() {
                                log::error!("yt-dlp stdout reader panicked for task {id2}");
                            }
                        }
                        if let Some(h) = stderr_handle {
                            if h.join().is_err() {
                                log::error!("yt-dlp stderr reader panicked for task {id2}");
                            }
                        }
                        let mut notif = String::new();
                        {
                            let mut jobs = lock_or_err!(state2.media_jobs);
                            if let Some(current) = jobs.get_mut(&id2) {
                                let task_name = current.task.name.clone();
                                // Exit code 0 alone is not proof of success:
                                // verify a non-empty output file exists before
                                // marking the task completed.
                                let output_verified = status.is_some_and(|s| s.success())
                                    && media_output_produced(&current.task);
                                if status.is_some_and(|s| s.success()) && output_verified {
                                    current.task.status = "completed".to_owned();
                                    current.task.downloaded_bytes = current.task.size_bytes;
                                    current.task.speed_bytes_per_sec = 0;
                                    current.task.time_left_seconds = 0;
                                    current.task.engine_status = Some("complete".to_owned());
                                    notif = format!("Download completed: {task_name}");
                                    if let Ok(mut stats) = state2.download_stats.lock() {
                                        stats.total_completed += 1;
                                        stats.total_downloaded_bytes += current.task.size_bytes;
                                    }
                                } else if status.is_some_and(|s| s.success()) {
                                    log::error!(
                                        "yt-dlp exited 0 but produced no output file for task {} (save_path: {})",
                                        id2, current.task.save_path
                                    );
                                    current.task.status = "error".to_owned();
                                    current.task.speed_bytes_per_sec = 0;
                                    current.task.engine_status = Some("no-output".to_owned());
                                    current.task.error_message = Some(
                                        "The media engine reported success but no output file was produced".to_owned(),
                                    );
                                    notif = format!("Download failed: {task_name}");
                                    if let Ok(mut stats) = state2.download_stats.lock() {
                                        stats.total_failed += 1;
                                    }
                                } else if current.task.status != "paused" {
                                    current.task.status = "error".to_owned();
                                    current.task.speed_bytes_per_sec = 0;
                                    current.task.engine_status = Some(format!(
                                        "exit-{}",
                                        status.map_or(-1, |s| s.code().unwrap_or(-1))
                                    ));
                                    notif = format!("Download failed: {task_name}");
                                    if let Ok(mut stats) = state2.download_stats.lock() {
                                        stats.total_failed += 1;
                                    }
                                }
                            }
                        }
                        state2.mark_dirty();
                        if !notif.is_empty() {
                            let (token, enabled, chat_id, api_base) = {
                                let cfg = lock_or_err!(state2.telegram_config);
                                (
                                    cfg.token.clone(),
                                    cfg.enabled,
                                    cfg.chat_id,
                                    cfg.api_base.clone(),
                                )
                            };
                            if enabled && !token.is_empty() && chat_id != 0 {
                                crate::daemon::telegram::send_telegram_msg_blocking_with_api(
                                    &api_base, &token, chat_id, &notif,
                                );
                            }
                        }
                    }));
                    if let Err(panic_info) = result {
                        let msg = if let Some(s) = panic_info.downcast_ref::<&str>() {
                            format!("yt-dlp worker panicked: {s}")
                        } else if let Some(s) = panic_info.downcast_ref::<String>() {
                            format!("yt-dlp worker panicked: {s}")
                        } else {
                            "yt-dlp worker panicked with unknown payload".to_owned()
                        };
                        log::error!("{msg} (task: {id2})");
                        let mut jobs = lock_or_err!(state2.media_jobs);
                        if let Some(current) = jobs.get_mut(&id2) {
                            current.task.status = "error".to_owned();
                            current.task.engine_status = Some("worker-panicked".to_owned());
                            current.task.error_message = Some(msg);
                        }
                        state2.mark_dirty();
                    }
                });
                let task_data;
                {
                    let mut jobs = lock_or_err!(state.media_jobs);
                    if let Some(j) = jobs.get_mut(id) {
                        j.child = Some(child_pid);
                        j.task.status = "downloading".to_owned();
                        j.task.engine_status = Some("running".to_owned());
                    }
                    task_data = jobs.get(id).map(|j| j.task.clone());
                }
                state.mark_dirty();
                if let Some(task_data) = task_data {
                    if let Ok(mut snapshot) = state.task_snapshot.lock() {
                        snapshot.insert(id.to_owned(), task_data);
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to start yt-dlp: {e}");
                let mut jobs = lock_or_err!(state.media_jobs);
                if let Some(j) = jobs.get_mut(id) {
                    j.task.status = "error".to_owned();
                    j.task.error_message = Some(format!("Failed to start: {e}"));
                }
                state.mark_dirty();
            }
        }
    }
}

fn progress_value<'a>(payload: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key}=");
    payload
        .split_whitespace()
        .find_map(|part| part.strip_prefix(&prefix))
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "NA" && *value != "None")
}

fn parse_progress_u64(value: &str) -> Option<u64> {
    value.parse::<u64>().ok().or_else(|| {
        value
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .map(|value| value as u64)
    })
}

/// Verify that a finished yt-dlp task actually produced a non-empty file.
/// Checks the recorded `save_path` first, then sibling files sharing the same
/// stem (format merges change the extension, e.g. `.mkv`; audio extraction
/// produces `.mp3`/`.opus`, and thumbnails/subtitles are skipped because
/// they never become the recorded `save_path`).
fn media_output_produced(task: &crate::daemon::types::Task) -> bool {
    if task.save_path.is_empty() {
        // No destination was ever reported; nothing to verify against, so
        // do not manufacture a failure.
        return true;
    }
    let path = std::path::Path::new(&task.save_path);
    let non_empty =
        |p: &std::path::Path| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() > 0);
    if non_empty(path) {
        return true;
    }
    let (Some(parent), Some(stem)) = (path.parent(), path.file_stem()) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(parent) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        let p = entry.path();
        p != path && p.file_stem() == Some(stem) && non_empty(&p)
    })
}

fn update_structured_progress(record: &mut MediaJob, payload: &str) {
    if let Some(total) = progress_value(payload, "total").and_then(parse_progress_u64) {
        record.task.size_bytes = total;
    }
    if let Some(downloaded) = progress_value(payload, "downloaded").and_then(parse_progress_u64) {
        record.task.downloaded_bytes = downloaded;
    }
    if let Some(speed) = progress_value(payload, "speed").and_then(parse_progress_u64) {
        record.task.speed_bytes_per_sec = speed;
    }
    if let Some(eta) = progress_value(payload, "eta").and_then(parse_progress_u64) {
        record.task.time_left_seconds = eta;
    }
    record.task.elapsed_seconds = record.start_time.elapsed().as_secs();
    if record.task.size_bytes > 0 {
        // Progress parsers can briefly report bytes beyond a just-refined
        // total (for example while a post-processor finalizes a media file).
        // Keep the raw task count for diagnostics, but the rendered segment is
        // a bounded range so every progress surface remains 0..=100%.
        let segment_downloaded = record.task.downloaded_bytes.min(record.task.size_bytes);
        record.task.segments = vec![Segment {
            id: 0,
            progress: segment_downloaded as f64 / record.task.size_bytes as f64,
            downloaded_bytes: segment_downloaded,
            total_bytes: record.task.size_bytes,
            active: true,
            speed: record.task.speed_bytes_per_sec,
            start_byte: 0,
            end_byte: record.task.size_bytes.saturating_sub(1),
        }];
    }
}

pub fn update_ytdlp_progress(state: &SharedState, id: &str, text: &str) {
    let mut jobs = match state.media_jobs.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!("Mutex poisoned in update_ytdlp_progress: {poisoned}");
            return;
        }
    };
    let record = match jobs.get_mut(id) {
        Some(r) => r,
        None => return,
    };

    for line in text.lines() {
        if let Some(dest) = line.strip_prefix("Destination: ") {
            record.task.save_path = dest.trim().to_owned();
            // The reported destination derives from the server-controlled
            // media title, so the display name is sanitized to a bare safe
            // name (control chars, Windows reserved devices, length bound —
            // mirrors the curl engine path). `save_path` itself is kept
            // verbatim: it is the real on-disk path yt-dlp reported, which
            // `media_output_produced` validates against for completion.
            if let Some(name) = std::path::Path::new(dest.trim())
                .file_name()
                .and_then(|n| n.to_str())
            {
                record.task.name = crate::daemon::utils::sanitize_derived_file_name(name);
            }
        }

        if let Some(payload) = line.strip_prefix("NOVA_PROGRESS ") {
            update_structured_progress(record, payload);
            continue;
        }

        if let Some(pct_str) = line.split('%').next() {
            if let Ok(pct) = pct_str.trim().parse::<f64>() {
                let total_str = line.split("of ").nth(1).and_then(|s| s.split(' ').next());
                let speed_str = line.split("at ").nth(1).and_then(|s| s.split(' ').next());
                let eta_str = line.split("ETA ").nth(1).and_then(|s| s.split(' ').next());

                if let Some(t) = total_str {
                    if let Some(bytes) = parse_size(t) {
                        record.task.size_bytes = bytes;
                        record.task.downloaded_bytes = (bytes as f64 * pct / 100.0) as u64;
                    }
                }
                if let Some(s) = speed_str {
                    if let Some(bps) = parse_speed(s) {
                        record.task.speed_bytes_per_sec = bps;
                    }
                }
                if let Some(e) = eta_str {
                    if let Some(secs) = parse_eta(e) {
                        record.task.time_left_seconds = secs;
                    }
                }
            }
        }
    }

    let task_data = jobs.get(id).map(|j| j.task.clone());
    state.mark_dirty();
    if let Some(task_data) = task_data {
        if let Ok(mut snapshot) = state.task_snapshot.lock() {
            snapshot.insert(id.to_owned(), task_data);
        }
    }
    drop(jobs);
}

pub fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let known_suffixes: &[(&str, u64)] = &[
        ("TiB", 1024 * 1024 * 1024 * 1024),
        ("GiB", 1024 * 1024 * 1024),
        ("MiB", 1024 * 1024),
        ("KiB", 1024),
        ("TB", 1024 * 1024 * 1024 * 1024),
        ("GB", 1024 * 1024 * 1024),
        ("MB", 1024 * 1024),
        ("KB", 1024),
    ];
    let upper = s.to_ascii_uppercase();
    for (suffix, multiplier) in known_suffixes {
        if let Some(rest) = upper.strip_suffix(suffix) {
            let trimmed = rest.trim();
            if !trimmed.is_empty() && !trimmed.contains(|c: char| c.is_ascii_alphabetic()) {
                let num: f64 = trimmed.parse().ok()?;
                return Some((num * *multiplier as f64) as u64);
            }
        }
    }
    if let Some(rest) = s.strip_suffix('B').or(s.strip_suffix('b')).map(str::trim) {
        if !rest.is_empty() && !rest.contains(|c: char| c.is_ascii_alphabetic()) {
            let num: f64 = rest.parse().ok()?;
            return Some(num as u64);
        }
    }
    s.parse::<f64>().ok().map(|n| n as u64)
}

pub fn parse_speed(s: &str) -> Option<u64> {
    parse_size(s)
}

pub fn parse_eta(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() == 3 {
        let h: u64 = parts[0].parse().ok()?;
        let m: u64 = parts[1].parse().ok()?;
        let s: u64 = parts[2].parse().ok()?;
        Some(h * 3600 + m * 60 + s)
    } else if parts.len() == 2 {
        let m: u64 = parts[0].parse().ok()?;
        let s: u64 = parts[1].parse().ok()?;
        Some(m * 60 + s)
    } else {
        s.parse::<u64>().ok()
    }
}

fn trimmed(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn push_number_arg(args: &mut Vec<String>, flag: &str, value: Option<u64>) {
    if let Some(value) = value.filter(|value| *value > 0) {
        push_arg(args, flag, &value.to_string());
    }
}

fn safe_cli_value(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\0', '\n', '\r'])
}

fn push_string_arg(args: &mut Vec<String>, flag: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        if !safe_cli_value(value) {
            return Err(format!("Rejected unsafe value for {flag}"));
        }
        push_arg(args, flag, value);
    }
    Ok(())
}

fn push_bool_flag(
    args: &mut Vec<String>,
    enabled: Option<bool>,
    when_true: &str,
    when_false: Option<&str>,
) {
    match enabled {
        Some(true) => args.push(when_true.to_owned()),
        Some(false) => {
            if let Some(flag) = when_false {
                args.push(flag.to_owned());
            }
        }
        None => {}
    }
}

fn push_header_lines(args: &mut Vec<String>, raw_headers: &str) {
    for line in raw_headers
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if line.contains(':') {
            push_arg(args, "--add-header", line);
        }
    }
}

fn push_cookie_args(args: &mut Vec<String>, cookies: &str) {
    let looks_like_cookie_header =
        cookies.contains('=') && !cookies.ends_with(".txt") && !cookies.contains('\\');
    if looks_like_cookie_header {
        push_arg(args, "--add-header", &format!("Cookie: {cookies}"));
    } else {
        push_arg(args, "--cookies", cookies);
    }
}

pub fn build_ytdlp_args_with_engines(
    body: &CreateDownloadBody,
    ffmpeg_bin: Option<&str>,
) -> Result<Vec<String>, String> {
    let url = body.url.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing url".to_owned());
    }
    if url.starts_with('-') {
        return Err("Invalid url: must not start with '-'".to_owned());
    }

    let media = body
        .media_options
        .as_ref()
        .ok_or_else(|| "Missing media_options for yt-dlp task".to_owned())?;
    let output_template = media
        .output_template
        .clone()
        .unwrap_or_else(|| "%(title)s.%(ext)s".to_owned());
    let mut args = vec![
        "--no-colors".to_owned(),
        "--newline".to_owned(),
        "--progress-template".to_owned(),
        "stdout:NOVA_PROGRESS downloaded=%(progress.downloaded_bytes)s total=%(progress.total_bytes)s speed=%(progress.speed)s eta=%(progress.eta)s".to_owned(),
        "-o".to_owned(),
        output_template,
        "--print".to_owned(),
        "after_move:Destination: %(filepath)s".to_owned(),
    ];

    if let Some(sp) = &body.save_path {
        // Neutralize traversal in the yt-dlp output directory (mirrors the
        // curl engine path) so a server-controlled title or save path cannot
        // make yt-dlp write outside the chosen folder.
        let safe_sp = crate::daemon::utils::sanitize_output_path(std::path::Path::new(sp));
        if let Some(parent) = safe_sp.parent() {
            let dir = parent.to_string_lossy().to_string();
            if !dir.is_empty() {
                push_arg(&mut args, "-P", &dir);
            }
        }
    }

    let ffmpeg_enabled = media.ffmpeg_enabled.unwrap_or(true);
    if ffmpeg_enabled {
        if let Some(ffmpeg_location) = trimmed(&media.ffmpeg_location) {
            push_arg(&mut args, "--ffmpeg-location", ffmpeg_location);
        } else if let Some(ffmpeg_bin) = ffmpeg_bin.filter(|path| Path::new(path).exists()) {
            push_arg(&mut args, "--ffmpeg-location", ffmpeg_bin);
        }
    }

    if media.mode.as_deref() == Some("audio") {
        args.push("-x".to_owned());
        push_arg(
            &mut args,
            "--audio-format",
            media.audio_format.as_deref().unwrap_or("mp3"),
        );
        if let Some(bitrate) = trimmed(&media.bitrate) {
            push_arg(&mut args, "--audio-quality", bitrate);
        }
    } else {
        let format_selector = if let Some(format_selector) = trimmed(&media.format_selector) {
            format_selector.to_owned()
        } else if let Some(q) = trimmed(&media.quality).filter(|quality| *quality != "best") {
            let height = q.strip_suffix('p').unwrap_or(q);
            format!("bv*[height<={height}]+ba/b[height<={height}]")
        } else {
            "bv*+ba/b".to_owned()
        };
        push_arg(&mut args, "-f", &format_selector);
        if let Some(format_sort) = trimmed(&media.format_sort) {
            push_arg(&mut args, "--format-sort", format_sort);
        }
    }

    let write_subs = media.subtitles.unwrap_or(false);
    let write_auto_subs = media.auto_subtitles.unwrap_or(false);
    if write_subs {
        args.push("--write-subs".to_owned());
    }
    if write_auto_subs {
        args.push("--write-auto-subs".to_owned());
    }
    if write_subs || write_auto_subs {
        push_arg(
            &mut args,
            "--sub-langs",
            trimmed(&media.subtitle_languages).unwrap_or("en"),
        );
        if ffmpeg_enabled && media.embed_subtitles.unwrap_or(false) {
            args.push("--embed-subs".to_owned());
        }
    }

    if media.write_thumbnail.unwrap_or(false) {
        args.push("--write-thumbnail".to_owned());
    }
    if ffmpeg_enabled && media.embed_thumbnail.unwrap_or(false) {
        args.push("--embed-thumbnail".to_owned());
    }
    if media.write_info_json.unwrap_or(false) {
        args.push("--write-info-json".to_owned());
    }
    if media.write_description.unwrap_or(false) {
        args.push("--write-description".to_owned());
    }
    if media.split_chapters.unwrap_or(false) {
        args.push("--split-chapters".to_owned());
    }
    if let Some(sponsor_block) = trimmed(&media.sponsor_block) {
        push_arg(&mut args, "--sponsorblock-remove", sponsor_block);
    }

    if media.playlist.unwrap_or(false) {
        if let Some(items) = trimmed(&media.playlist_items) {
            push_arg(&mut args, "--playlist-items", items);
        }
    } else {
        args.push("--no-playlist".to_owned());
    }

    if let Some(proxy) = trimmed(&media.proxy) {
        if crate::daemon::curl::proxy_resolves_to_internal(proxy) {
            return Err("Rejected proxy pointing to internal address for --proxy".to_owned());
        }
        push_arg(&mut args, "--proxy", proxy);
    }
    if let Some(source_address) = trimmed(&media.source_address) {
        push_arg(&mut args, "--source-address", source_address);
    }
    if let Some(cookies) = trimmed(&media.cookies) {
        push_cookie_args(&mut args, cookies);
    }
    if let Some(cookies_from_browser) = trimmed(&media.cookies_from_browser) {
        // Whitelist safe browser names to prevent arbitrary argument injection.
        let safe_browsers = [
            "chrome", "firefox", "edge", "opera", "brave", "vivaldi", "safari", "chromium",
        ];
        if safe_browsers
            .iter()
            .any(|b| cookies_from_browser.eq_ignore_ascii_case(b))
        {
            push_arg(&mut args, "--cookies-from-browser", cookies_from_browser);
        }
    }
    if let Some(ua) = trimmed(&media.user_agent) {
        push_arg(&mut args, "--user-agent", ua);
    }
    if let Some(referer) = trimmed(&media.referer) {
        push_arg(&mut args, "--referer", referer);
    }
    if let Some(headers) = trimmed(&media.headers) {
        push_header_lines(&mut args, headers);
    }

    if let Some(rl) = media.rate_limit_kbs.filter(|rl| *rl > 0) {
        push_arg(&mut args, "--limit-rate", &format!("{rl}K"));
    }
    push_number_arg(&mut args, "--retries", media.retries);
    push_number_arg(&mut args, "--fragment-retries", media.fragment_retries);
    push_number_arg(
        &mut args,
        "--concurrent-fragments",
        media.concurrent_fragments,
    );
    push_number_arg(&mut args, "--sleep-interval", media.sleep_interval_sec);
    push_number_arg(
        &mut args,
        "--max-sleep-interval",
        media.max_sleep_interval_sec,
    );
    if let Some(sections) = trimmed(&media.download_sections) {
        push_arg(&mut args, "--download-sections", sections);
    }
    if let Some(filter) = trimmed(&media.match_filter) {
        push_arg(&mut args, "--match-filter", filter);
    }
    if ffmpeg_enabled {
        if let Some(remux_format) = trimmed(&media.remux_format) {
            push_arg(&mut args, "--remux-video", remux_format);
        }
    }
    push_number_arg(
        &mut args,
        "--file-access-retries",
        media.file_access_retries,
    );
    push_string_arg(&mut args, "--retry-sleep", trimmed(&media.retry_sleep))?;
    if let Some(rate) = media.throttled_rate_kbs.filter(|rate| *rate > 0) {
        push_arg(&mut args, "--throttled-rate", &format!("{rate}K"));
    }
    if let Some(size) = media.buffer_size_kbs.filter(|size| *size > 0) {
        push_arg(&mut args, "--buffer-size", &format!("{size}K"));
    }
    push_string_arg(
        &mut args,
        "--http-chunk-size",
        trimmed(&media.http_chunk_size),
    )?;
    if let Some(external_downloader) = trimmed(&media.external_downloader) {
        if external_downloader != "auto" && external_downloader != "native" {
            let value = match external_downloader {
                "curl" => {
                    return Err("The curl external downloader binary is no longer bundled. Use 'native' for yt-dlp's built-in HTTP client, or 'ffmpeg' for media processing.".to_owned());
                }
                "ffmpeg" | "httpie" | "wget" | "axel" => external_downloader.to_owned(),
                other => {
                    return Err(format!(
                        "Unsupported external downloader '{other}'. Allowed values: native, curl, ffmpeg, httpie, wget, axel."
                    ));
                }
            };
            push_string_arg(&mut args, "--downloader", Some(&value))?;
        }
    }
    // Filter --downloader-args to prevent command injection through external
    // downloaders (ffmpeg can execute arbitrary commands via filter syntax).
    if let Some(dl_args) = trimmed(&media.external_downloader_args) {
        let has_danger = dl_args
            .chars()
            .any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '\n' | '\r'));
        if has_danger {
            return Err("downloader-args contain unsafe characters".to_owned());
        }
        push_string_arg(&mut args, "--downloader-args", Some(dl_args))?;
    }
    push_string_arg(
        &mut args,
        "--download-archive",
        trimmed(&media.download_archive),
    )?;
    push_bool_flag(
        &mut args,
        media.break_on_existing,
        "--break-on-existing",
        None,
    );
    push_bool_flag(
        &mut args,
        media.force_overwrites,
        "--force-overwrites",
        Some("--no-force-overwrites"),
    );
    push_bool_flag(&mut args, media.no_overwrites, "--no-overwrites", None);
    push_bool_flag(
        &mut args,
        media.restrict_filenames,
        "--restrict-filenames",
        Some("--no-restrict-filenames"),
    );
    push_bool_flag(
        &mut args,
        media.windows_filenames,
        "--windows-filenames",
        Some("--no-windows-filenames"),
    );
    if let Some(limit) = media.trim_filenames.filter(|limit| *limit > 0) {
        push_arg(&mut args, "--trim-filenames", &limit.to_string());
    }
    push_bool_flag(&mut args, media.write_comments, "--write-comments", None);
    if ffmpeg_enabled {
        push_bool_flag(
            &mut args,
            media.embed_metadata,
            "--embed-metadata",
            Some("--no-embed-metadata"),
        );
        push_bool_flag(
            &mut args,
            media.embed_chapters,
            "--embed-chapters",
            Some("--no-embed-chapters"),
        );
        push_string_arg(
            &mut args,
            "--convert-thumbnails",
            trimmed(&media.convert_thumbnails),
        )?;
        push_string_arg(
            &mut args,
            "--postprocessor-args",
            trimmed(&media.postprocessor_args),
        )?;
    }
    push_string_arg(
        &mut args,
        "--extractor-args",
        trimmed(&media.extractor_args),
    )?;
    push_string_arg(
        &mut args,
        "--compat-options",
        trimmed(&media.compat_options),
    )?;
    push_bool_flag(&mut args, media.live_from_start, "--live-from-start", None);
    push_string_arg(
        &mut args,
        "--wait-for-video",
        trimmed(&media.wait_for_video),
    )?;
    push_number_arg(&mut args, "--sleep-requests", media.sleep_requests_sec);
    push_number_arg(&mut args, "--sleep-subtitles", media.sleep_subtitles_sec);
    push_number_arg(&mut args, "--socket-timeout", media.socket_timeout_sec);
    push_string_arg(&mut args, "--min-filesize", trimmed(&media.min_filesize))?;
    push_string_arg(&mut args, "--max-filesize", trimmed(&media.max_filesize))?;
    push_number_arg(&mut args, "--max-downloads", media.max_downloads);
    push_string_arg(&mut args, "--username", trimmed(&media.username))?;
    push_string_arg(&mut args, "--password", trimmed(&media.password))?;
    push_string_arg(&mut args, "--twofactor", trimmed(&media.two_factor))?;
    push_bool_flag(&mut args, media.netrc, "--netrc", None);
    push_string_arg(
        &mut args,
        "--geo-bypass-country",
        trimmed(&media.geo_bypass_country),
    )?;

    if let Some(extra_args) = trimmed(&media.extra_args) {
        let mut rejected = Vec::new();
        for arg in crate::daemon::utils::shell_split(extra_args) {
            if is_safe_extra_arg(&arg) {
                args.push(arg);
            } else {
                rejected.push(arg);
            }
        }
        if !rejected.is_empty() {
            return Err(format!(
                "Rejected {} unsafe yt-dlp argument(s): {}. Only whitelisted flags are allowed.",
                rejected.len(),
                rejected.join(", ")
            ));
        }
    }

    args.push("--".to_owned());
    args.push(url.to_owned());
    Ok(args)
}

pub async fn create_ytdlp_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, String> {
    let url = body.url.as_deref().unwrap_or("");
    // The task name may be derived from a server-controlled media title;
    // sanitize it to a bare file name (mirrors the curl engine path in
    // args::destination_from_body) so a crafted title with path separators
    // or `..` traversal cannot become a path on disk.
    let name = crate::daemon::utils::sanitize_derived_file_name(
        &body.name.clone().unwrap_or_else(|| "media".to_owned()),
    );
    let id = Uuid::new_v4().to_string();

    // Block internal/loopback targets to prevent SSRF (matches curl engine path).
    if !url.is_empty() {
        crate::daemon::utils::is_safe_target_url(url)?;
    }

    // Enforce maximum task limit to prevent memory exhaustion
    if lock_or_err!(state.task_snapshot).len() >= 10_000 {
        return Err("Maximum number of tasks reached. Complete or delete some tasks before creating new ones.".to_owned());
    }

    if let Some(sp) = &body.save_path {
        // Neutralize any `..`/`.` traversal components in the user-supplied
        // save path so a server-controlled title cannot push yt-dlp's output
        // outside the chosen directory (mirrors sanitize_output_path in the
        // curl engine). The directory is preserved verbatim.
        let safe_sp = crate::daemon::utils::sanitize_output_path(std::path::Path::new(sp));
        if let Some(parent) = safe_sp.parent() {
            let dir = parent.to_string_lossy().to_string();
            if !dir.is_empty() {
                let _ = std::fs::create_dir_all(&dir);
            }
        }
    }

    let ytdlp_bin = state.ytdlp_binary();
    let ffmpeg_bin = state.ffmpeg_binary();
    if let Some(media_options) = body.media_options.as_ref() {
        engine_capabilities::validate_ytdlp_media_options(&ytdlp_bin, &ffmpeg_bin, media_options)?;
    }
    let args = build_ytdlp_args_with_engines(body, Some(&ffmpeg_bin))?;
    let should_start = body.start_immediately.unwrap_or(true);

    let task = Task {
        id: id.clone(),
        name,
        url: url.to_owned(),
        file_type: "video".to_owned(),
        status: if should_start {
            "downloading"
        } else {
            "queued"
        }
        .to_owned(),
        size_bytes: 0,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        elapsed_seconds: 0,
        date_added: now_str(),
        category: body.category.clone().unwrap_or_else(|| "video".to_owned()),
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_owned()),
        connections: 1,
        resumable: true,
        save_path: body.save_path.clone().unwrap_or_default(),
        description: body.description.clone().unwrap_or_default(),
        segments: vec![Segment {
            id: 0,
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            active: true,
            speed: 0,
            start_byte: 0,
            end_byte: 0,
        }],
        referer: None,
        engine: "yt-dlp".to_owned(),
        engine_id: id.clone(),
        engine_status: Some(if should_start { "starting" } else { "queued" }.to_owned()),
        error_message: None,
    };

    lock_or_err!(state.media_jobs).insert(
        id.clone(),
        MediaJob {
            task: task.clone(),
            child: None,
            args,
            start_time: std::time::Instant::now(),
        },
    );
    lock_or_err!(state.task_snapshot).insert(id.clone(), task.clone());
    state.mark_dirty();

    if should_start {
        start_ytdlp_process(state, &id);
    }

    Ok(task)
}

// ─── Extractor trait implementation ─────────────────────────────────

use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};

pub struct YtDlpExtractor {
    pub ytdlp_bin: String,
    pub ffmpeg_bin: String,
}

impl YtDlpExtractor {
    pub const fn new(ytdlp_bin: String, ffmpeg_bin: String) -> Self {
        Self {
            ytdlp_bin,
            ffmpeg_bin,
        }
    }
}

impl Extractor for YtDlpExtractor {
    fn id(&self) -> &'static str {
        "yt-dlp"
    }

    fn can_handle(&self, _url: &str, has_media_options: bool) -> bool {
        has_media_options
    }

    fn validate(&self, body: &CreateDownloadBody) -> Result<(), ValidateError> {
        let url = body.url.as_deref().unwrap_or("").trim();
        if url.is_empty() {
            return Err(ValidateError("Missing url".into()));
        }
        if url.starts_with('-') {
            return Err(ValidateError("Invalid url: must not start with '-'".into()));
        }
        if body.media_options.is_none() {
            return Err(ValidateError(
                "Missing media_options for yt-dlp task".into(),
            ));
        }
        if let Some(media) = body.media_options.as_ref() {
            crate::daemon::engine_capabilities::validate_ytdlp_media_options(
                &self.ytdlp_bin,
                &self.ffmpeg_bin,
                media,
            )
            .map_err(ValidateError)?;
        }
        Ok(())
    }

    fn engine_status(&self, _state: &SharedState) -> EngineStatus {
        let mut cmd = std::process::Command::new(&self.ytdlp_bin);
        crate::daemon::utils::hide_command_window(&mut cmd);
        let output = cmd.arg("--version").output();
        let (available, version) = match output {
            Ok(o) if o.status.success() => {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_owned();
                (true, Some(v))
            }
            _ => (false, None),
        };
        EngineStatus {
            id: "yt-dlp".to_owned(),
            name: "yt-dlp".to_owned(),
            available,
            version,
            features: vec!["media-extraction".to_owned(), "format-selection".to_owned()],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::MediaDownloadOptions;

    fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == flag && pair[1] == value)
    }

    fn media_body(media_options: MediaDownloadOptions) -> CreateDownloadBody {
        CreateDownloadBody {
            url: Some("https://example.com/watch?v=1".to_string()),
            name: Some("video".to_string()),
            file_type: None,
            size_bytes: None,
            category: None,
            queue_id: None,
            connections: None,
            resumable: None,
            save_path: Some("C:/Downloads/video.mp4".to_string()),
            description: None,
            referer: None,
            start_immediately: Some(true),
            direct_options: None,
            media_options: Some(media_options),
        }
    }

    #[test]
    fn build_ytdlp_args_applies_advanced_media_options() {
        let media_options = MediaDownloadOptions {
            mode: Some("video".to_string()),
            quality: Some("1080p".to_string()),
            format_selector: None,
            format_sort: Some("res,codec:avc:m4a".to_string()),
            audio_format: None,
            ffmpeg_enabled: Some(true),
            ffmpeg_location: Some("C:/ffmpeg/bin".to_string()),
            bitrate: None,
            output_template: Some("%(title)s.%(ext)s".to_string()),
            playlist: Some(true),
            playlist_items: Some("1,3,5".to_string()),
            subtitles: Some(true),
            subtitle_languages: Some("en,ar".to_string()),
            auto_subtitles: Some(true),
            embed_subtitles: Some(true),
            write_thumbnail: Some(true),
            embed_thumbnail: Some(true),
            write_info_json: Some(true),
            write_description: Some(true),
            split_chapters: Some(true),
            sponsor_block: Some("sponsor,selfpromo".to_string()),
            proxy: Some("http://8.8.8.8:8080".to_string()),
            source_address: Some("10.8.0.2".to_string()),
            cookies: Some("sid=abc".to_string()),
            cookies_from_browser: Some("chrome".to_string()),
            user_agent: Some("NOVA-Test".to_string()),
            referer: Some("https://example.com".to_string()),
            headers: Some("X-Test: yes".to_string()),
            rate_limit_kbs: Some(512),
            retries: Some(7),
            fragment_retries: Some(9),
            concurrent_fragments: Some(4),
            sleep_interval_sec: Some(2),
            max_sleep_interval_sec: Some(5),
            download_sections: Some("*00:01:00-00:02:00".to_string()),
            match_filter: Some("duration < 3600".to_string()),
            remux_format: Some("mp4".to_string()),
            extra_args: None,
            ..Default::default()
        };

        let args = build_ytdlp_args_with_engines(&media_body(media_options), None).unwrap();

        assert!(has_pair(
            &args,
            "-f",
            "bv*[height<=1080]+ba/b[height<=1080]"
        ));
        assert!(has_pair(&args, "--format-sort", "res,codec:avc:m4a"));
        assert!(has_pair(&args, "--ffmpeg-location", "C:/ffmpeg/bin"));
        assert!(has_pair(&args, "--playlist-items", "1,3,5"));
        assert!(args.contains(&"--write-auto-subs".to_string()));
        assert!(args.contains(&"--embed-subs".to_string()));
        assert!(args.contains(&"--write-thumbnail".to_string()));
        assert!(args.contains(&"--embed-thumbnail".to_string()));
        assert!(args.contains(&"--write-info-json".to_string()));
        assert!(args.contains(&"--write-description".to_string()));
        assert!(args.contains(&"--split-chapters".to_string()));
        assert!(has_pair(
            &args,
            "--sponsorblock-remove",
            "sponsor,selfpromo"
        ));
        assert!(has_pair(&args, "--proxy", "http://8.8.8.8:8080"));
        assert!(has_pair(&args, "--source-address", "10.8.0.2"));
        assert!(has_pair(&args, "--add-header", "Cookie: sid=abc"));
        assert!(has_pair(&args, "--cookies-from-browser", "chrome"));
        assert!(has_pair(&args, "--referer", "https://example.com"));
        assert!(has_pair(&args, "--add-header", "X-Test: yes"));
        assert!(has_pair(&args, "--fragment-retries", "9"));
        assert!(has_pair(&args, "--download-sections", "*00:01:00-00:02:00"));
        assert!(has_pair(&args, "--match-filter", "duration < 3600"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("https://example.com/watch?v=1")
        );
    }

    #[test]
    fn ytdlp_rejects_internal_proxy() {
        let options = MediaDownloadOptions {
            proxy: Some("http://127.0.0.1:8080".to_owned()),
            ..Default::default()
        };

        let error = build_ytdlp_args_with_engines(&media_body(options), None)
            .expect_err("internal proxy must be rejected");
        assert!(error.contains("internal address"));
    }

    #[test]
    fn ytdlp_output_dir_neutralizes_path_traversal() {
        // A server-controlled save path (or title-derived name) with `..`
        // must never become yt-dlp's output directory (CWE-22, mirror of the
        // curl engine fix).
        let mut body = media_body(MediaDownloadOptions::default());
        body.save_path = Some("C:/Downloads/..%2F..%2F..%2Fevil.mp4".to_owned());
        let args = build_ytdlp_args_with_engines(&body, None).unwrap();
        // Compare as Path objects (Windows prints backslash separators).
        let p_val = args
            .windows(2)
            .find(|pair| pair[0] == "-P")
            .map(|pair| pair[1].clone());
        assert_eq!(
            p_val.map(std::path::PathBuf::from),
            Some(std::path::PathBuf::from("C:/Downloads"))
        );

        // A bare traversal save path collapses to a safe directory: the
        // `..` components are dropped (a literal `tmp` component may survive
        // as a legitimate directory name, but nothing may escape upward).
        let mut body2 = media_body(MediaDownloadOptions::default());
        body2.save_path = Some("../../../../tmp/evil.mp4".to_owned());
        let args2 = build_ytdlp_args_with_engines(&body2, None).unwrap();
        let p_val = args2
            .windows(2)
            .find(|pair| pair[0] == "-P")
            .map(|pair| pair[1].clone());
        // The directory may be empty after neutralization (collapses to the
        // file component's parent-less path) — either way no `..` survives.
        if let Some(dir) = p_val {
            assert!(
                !dir.contains(".."),
                "traversal survived in yt-dlp output dir: {dir}"
            );
            // Relative traversal targets must not survive as path escapes;
            // a leftover `tmp` component is fine only if it does not begin
            // with a parent-dir escape.
            assert!(
                !std::path::Path::new(&dir).is_absolute() || !dir.contains("tmp"),
                "traversal target leaked: {dir}"
            );
        }
    }

    #[test]
    fn ytdlp_destination_name_is_sanitized() {
        // The `Destination:` line yt-dlp prints derives from the
        // server-controlled media title; the recorded task name must be a
        // bare safe name (control chars, Windows reserved devices, `..`).
        // `save_path` itself stays verbatim because it is the real on-disk
        // path that `media_output_produced` validates against.
        let dir = std::env::temp_dir().join(format!("nova-ytdlp-name-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.display().to_string();
        let state = std::sync::Arc::new(crate::daemon::persist::tests::test_state(&dir_str));
        let id = "m1".to_string();
        state.media_jobs.lock().unwrap().insert(
            id.clone(),
            MediaJob {
                task: crate::daemon::types::Task {
                    id: id.clone(),
                    name: "placeholder".to_owned(),
                    url: "https://example.com/v".to_owned(),
                    file_type: "video".to_owned(),
                    status: "downloading".to_owned(),
                    size_bytes: 0,
                    downloaded_bytes: 0,
                    speed_bytes_per_sec: 0,
                    time_left_seconds: 0,
                    elapsed_seconds: 0,
                    date_added: String::new(),
                    category: "video".to_owned(),
                    queue_id: "main".to_owned(),
                    connections: 1,
                    resumable: true,
                    save_path: String::new(),
                    description: String::new(),
                    segments: Vec::new(),
                    referer: None,
                    engine: "yt-dlp".to_owned(),
                    engine_id: id.clone(),
                    engine_status: None,
                    error_message: None,
                },
                child: None,
                args: Vec::new(),
                start_time: std::time::Instant::now(),
            },
        );
        update_ytdlp_progress(
            &state,
            &id,
            "Destination: C:/Downloads/..%2F..%2F..%2FCON.mp4",
        );
        let record = state.media_jobs.lock().unwrap();
        let task = &record.get(&id).unwrap().task;
        // The name is neutralized to a safe bare name (no `..`, no reserved
        // device), while the real on-disk path is preserved verbatim.
        assert_eq!(task.name, "download");
        assert_eq!(task.save_path, "C:/Downloads/..%2F..%2F..%2FCON.mp4");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn structured_progress_clamps_segment_to_known_total() {
        let mut record = MediaJob {
            task: crate::daemon::types::Task {
                id: "media-progress".to_owned(),
                name: "media.mp4".to_owned(),
                url: "https://example.com/watch?v=1".to_owned(),
                file_type: "video".to_owned(),
                status: "downloading".to_owned(),
                size_bytes: 0,
                downloaded_bytes: 0,
                speed_bytes_per_sec: 0,
                time_left_seconds: 0,
                elapsed_seconds: 0,
                date_added: String::new(),
                category: "video".to_owned(),
                queue_id: "main".to_owned(),
                connections: 1,
                resumable: true,
                save_path: "media.mp4".to_owned(),
                description: String::new(),
                segments: Vec::new(),
                referer: None,
                engine: "yt-dlp".to_owned(),
                engine_id: "media-progress".to_owned(),
                engine_status: None,
                error_message: None,
            },
            child: None,
            args: Vec::new(),
            start_time: std::time::Instant::now(),
        };

        update_structured_progress(
            &mut record,
            "NOVA_PROGRESS downloaded=150 total=100 speed=10 eta=1",
        );
        let segment = &record.task.segments[0];
        assert_eq!(record.task.downloaded_bytes, 150);
        assert_eq!(segment.downloaded_bytes, 100);
        assert_eq!(segment.total_bytes, 100);
        assert_eq!(segment.progress, 1.0);
        assert_eq!(segment.end_byte, 99);
    }

    #[test]
    fn ytdlp_task_name_is_sanitized() {
        // The media title is server-controlled; a crafted title with path
        // separators must be reduced to a bare file name.
        let mut body = media_body(MediaDownloadOptions::default());
        body.name = Some("..%2F..%2FWindows%2Fevil.mp4".to_owned());
        let sanitized = crate::daemon::utils::sanitize_derived_file_name(
            &body.name.clone().unwrap_or_else(|| "media".to_owned()),
        );
        assert_eq!(sanitized, "evil.mp4");
        // The plain-media default stays intact.
        assert_eq!(
            crate::daemon::utils::sanitize_derived_file_name("my song.mp4"),
            "my song.mp4"
        );
    }
}
