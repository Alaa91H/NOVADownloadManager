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
    "--embed-metadata",
    "--no-embed-metadata",
    "--embed-chapters",
    "--convert-thumbnails",
    "--postprocessor-args",
    "--extractor-args",
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
    "--geo-bypass-country",
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
    "--download-archive",
];

fn is_safe_extra_arg(arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    // Reject shell metacharacters in any extra arg
    if arg.contains(|c: char| {
        c == ';' || c == '|' || c == '&' || c == '$' || c == '`' || c == '\n' || c == '\r'
    }) {
        return false;
    }
    // Non-flag args (no leading `-`) are allowed as values for preceding flags
    if !arg.starts_with('-') {
        return true;
    }
    // For flags, only allow known-safe ones (whitelist approach)
    if let Some(allowed) = ALLOWED_YTDLP_ARGS
        .iter()
        .find(|allowed| arg == **allowed || arg.starts_with(&format!("{}=", allowed)))
    {
        // Reject path traversal in flags that accept file paths
        if let Some(value) = arg.strip_prefix(&format!("{}=", allowed)) {
            if PATH_VALUE_FLAGS.contains(allowed) && value.contains("..") {
                log::warn!("Rejected path traversal in extra_arg: {}", arg);
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
        log::info!("Starting yt-dlp process for task {}", id);
        let mut cmd = Command::new(&state.ytdlp_bin);
        hide_command_window(&mut cmd);
        match cmd
            .args(&job.args)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(mut child) => {
                let child_pid = child.id();
                let stdout = child.stdout.take();
                let state2 = state.clone();
                let id2 = id.to_string();
                std::thread::spawn(move || {
                    if let Some(r) = stdout {
                        let reader = BufReader::new(r);
                        for line in reader.lines().map_while(Result::ok) {
                            if !line.is_empty() {
                                update_ytdlp_progress(&state2, &id2, &line);
                            }
                        }
                    }

                    let status = child.wait().ok();
                    let mut notif = String::new();
                    {
                        let mut jobs = lock_or_err!(state2.media_jobs);
                        if let Some(current) = jobs.get_mut(&id2) {
                            let task_name = current.task.name.clone();
                            if status.is_some_and(|s| s.success()) {
                                current.task.status = "completed".to_string();
                                current.task.downloaded_bytes = current.task.size_bytes;
                                current.task.speed_bytes_per_sec = 0;
                                current.task.time_left_seconds = 0;
                                current.task.engine_status = Some("complete".to_string());
                                notif = format!("Download completed: {}", task_name);
                            } else if current.task.status != "paused" {
                                current.task.status = "error".to_string();
                                current.task.speed_bytes_per_sec = 0;
                                current.task.engine_status = Some(format!(
                                    "exit-{}",
                                    status.map_or(-1, |s| s.code().unwrap_or(-1))
                                ));
                                notif = format!("Download failed: {}", task_name);
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
                });
                let mut jobs = lock_or_err!(state.media_jobs);
                if let Some(j) = jobs.get_mut(id) {
                    j.child = Some(child_pid);
                    j.task.status = "downloading".to_string();
                    j.task.engine_status = Some("running".to_string());
                }
            }
            Err(e) => {
                log::error!("Failed to start yt-dlp: {}", e);
                let mut jobs = lock_or_err!(state.media_jobs);
                if let Some(j) = jobs.get_mut(id) {
                    j.task.status = "error".to_string();
                    j.task.error_message = Some(format!("Failed to start: {}", e));
                }
            }
        }
    }
}

fn progress_value<'a>(payload: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{}=", key);
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
    if record.task.size_bytes > 0 {
        record.task.segments = vec![Segment {
            id: 0,
            progress: record.task.downloaded_bytes as f64 / record.task.size_bytes as f64,
            downloaded_bytes: record.task.downloaded_bytes,
            total_bytes: record.task.size_bytes,
            active: true,
            speed: record.task.speed_bytes_per_sec,
        }];
    }
}

pub fn update_ytdlp_progress(state: &SharedState, id: &str, text: &str) {
    let mut jobs = match state.media_jobs.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            log::error!("Mutex poisoned in update_ytdlp_progress: {}", poisoned);
            return;
        }
    };
    let record = match jobs.get_mut(id) {
        Some(r) => r,
        None => return,
    };

    for line in text.lines() {
        if let Some(dest) = line.strip_prefix("Destination: ") {
            record.task.save_path = dest.trim().to_string();
            if let Some(name) = std::path::Path::new(dest.trim())
                .file_name()
                .and_then(|n| n.to_str())
            {
                record.task.name = name.to_string();
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
}

pub fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    // Try to split between numeric part and unit suffix.
    // Units are either 2 chars (KB, MB, GB, TB, KiB, MiB, GiB, TiB) or 1 char (B).
    let unit_start = s.len().saturating_sub(2);
    let (num_str, unit) = s.split_at(unit_start);
    let trimmed_unit = unit.trim();
    if trimmed_unit.len() == 2 && !trimmed_unit.contains(|c: char| c.is_ascii_digit()) {
        let num: f64 = num_str.trim().parse().ok()?;
        match trimmed_unit {
            "KB" | "KiB" => Some((num * 1024.0) as u64),
            "MB" | "MiB" => Some((num * 1024.0 * 1024.0) as u64),
            "GB" | "GiB" => Some((num * 1024.0 * 1024.0 * 1024.0) as u64),
            "TB" | "TiB" => Some((num * 1024.0 * 1024.0 * 1024.0 * 1024.0) as u64),
            _ => s.parse::<f64>().ok().map(|n| n as u64),
        }
    } else {
        // Single-letter unit (B) or no unit
        let unit_start = s.len().saturating_sub(1);
        let (num_str, unit) = s.split_at(unit_start);
        if unit.trim() == "B" {
            let num: f64 = num_str.trim().parse().ok()?;
            Some(num as u64)
        } else {
            s.parse::<f64>().ok().map(|n| n as u64)
        }
    }
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
            return Err(format!("Rejected unsafe value for {}", flag));
        }
        push_arg(args, flag, value);
    }
    Ok(())
}

fn push_bool_flag(args: &mut Vec<String>, enabled: Option<bool>, when_true: &str, when_false: Option<&str>) {
    match enabled {
        Some(true) => args.push(when_true.to_string()),
        Some(false) => {
            if let Some(flag) = when_false {
                args.push(flag.to_string());
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
        push_arg(args, "--add-header", &format!("Cookie: {}", cookies));
    } else {
        push_arg(args, "--cookies", cookies);
    }
}

#[cfg(test)]
pub(crate) fn build_ytdlp_args(body: &CreateDownloadBody) -> Result<Vec<String>, String> {
    build_ytdlp_args_with_engines(body, None, None)
}

pub(crate) fn build_ytdlp_args_with_engines(
    body: &CreateDownloadBody,
    curl_bin: Option<&str>,
    ffmpeg_bin: Option<&str>,
) -> Result<Vec<String>, String> {
    let url = body.url.as_deref().unwrap_or("").trim();
    if url.is_empty() {
        return Err("Missing url".to_string());
    }
    if url.starts_with('-') {
        return Err("Invalid url: must not start with '-'".to_string());
    }

    let media = body
        .media_options
        .as_ref()
        .ok_or_else(|| "Missing media_options for yt-dlp task".to_string())?;
    let output_template = media
        .output_template
        .clone()
        .unwrap_or_else(|| "%(title)s.%(ext)s".to_string());
    let mut args = vec![
        "--no-colors".to_string(),
        "--newline".to_string(),
        "--progress-template".to_string(),
        "stdout:NOVA_PROGRESS downloaded=%(progress.downloaded_bytes)s total=%(progress.total_bytes)s speed=%(progress.speed)s eta=%(progress.eta)s".to_string(),
        "-o".to_string(),
        output_template,
        "--print".to_string(),
        "after_move:Destination: %(filepath)s".to_string(),
    ];

    if let Some(sp) = &body.save_path {
        if let Some(parent) = std::path::Path::new(sp).parent() {
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

    match media.mode.as_deref() {
        Some("audio") => {
            args.push("-x".to_string());
            push_arg(
                &mut args,
                "--audio-format",
                media.audio_format.as_deref().unwrap_or("mp3"),
            );
            if let Some(bitrate) = trimmed(&media.bitrate) {
                push_arg(&mut args, "--audio-quality", bitrate);
            }
        }
        _ => {
            let format_selector = if let Some(format_selector) = trimmed(&media.format_selector) {
                format_selector.to_string()
            } else if let Some(q) = trimmed(&media.quality).filter(|quality| *quality != "best") {
                let height = q.strip_suffix('p').unwrap_or(q);
                format!("bv*[height<={}]+ba/b[height<={}]", height, height)
            } else {
                "bv*+ba/b".to_string()
            };
            push_arg(&mut args, "-f", &format_selector);
            if let Some(format_sort) = trimmed(&media.format_sort) {
                push_arg(&mut args, "--format-sort", format_sort);
            }
        }
    }

    let write_subs = media.subtitles.unwrap_or(false);
    let write_auto_subs = media.auto_subtitles.unwrap_or(false);
    if write_subs {
        args.push("--write-subs".to_string());
    }
    if write_auto_subs {
        args.push("--write-auto-subs".to_string());
    }
    if write_subs || write_auto_subs {
        push_arg(
            &mut args,
            "--sub-langs",
            trimmed(&media.subtitle_languages).unwrap_or("en"),
        );
        if ffmpeg_enabled && media.embed_subtitles.unwrap_or(false) {
            args.push("--embed-subs".to_string());
        }
    }

    if media.write_thumbnail.unwrap_or(false) {
        args.push("--write-thumbnail".to_string());
    }
    if ffmpeg_enabled && media.embed_thumbnail.unwrap_or(false) {
        args.push("--embed-thumbnail".to_string());
    }
    if media.write_info_json.unwrap_or(false) {
        args.push("--write-info-json".to_string());
    }
    if media.write_description.unwrap_or(false) {
        args.push("--write-description".to_string());
    }
    if media.split_chapters.unwrap_or(false) {
        args.push("--split-chapters".to_string());
    }
    if let Some(sponsor_block) = trimmed(&media.sponsor_block) {
        push_arg(&mut args, "--sponsorblock-remove", sponsor_block);
    }

    if media.playlist.unwrap_or(false) {
        if let Some(items) = trimmed(&media.playlist_items) {
            push_arg(&mut args, "--playlist-items", items);
        }
    } else {
        args.push("--no-playlist".to_string());
    }

    if let Some(proxy) = trimmed(&media.proxy) {
        push_arg(&mut args, "--proxy", proxy);
    }
    if let Some(source_address) = trimmed(&media.source_address) {
        push_arg(&mut args, "--source-address", source_address);
    }
    if let Some(cookies) = trimmed(&media.cookies) {
        push_cookie_args(&mut args, cookies);
    }
    if let Some(cookies_from_browser) = trimmed(&media.cookies_from_browser) {
        push_arg(&mut args, "--cookies-from-browser", cookies_from_browser);
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
        push_arg(&mut args, "--limit-rate", &format!("{}K", rl));
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
    push_number_arg(&mut args, "--file-access-retries", media.file_access_retries);
    push_string_arg(&mut args, "--retry-sleep", trimmed(&media.retry_sleep))?;
    if let Some(rate) = media.throttled_rate_kbs.filter(|rate| *rate > 0) {
        push_arg(&mut args, "--throttled-rate", &format!("{}K", rate));
    }
    if let Some(size) = media.buffer_size_kbs.filter(|size| *size > 0) {
        push_arg(&mut args, "--buffer-size", &format!("{}K", size));
    }
    push_string_arg(&mut args, "--http-chunk-size", trimmed(&media.http_chunk_size))?;
    if let Some(external_downloader) = trimmed(&media.external_downloader) {
        if external_downloader != "auto" && external_downloader != "native" {
            let value = match external_downloader {
                "curl" => curl_bin
                    .filter(|path| Path::new(path).exists())
                    .unwrap_or("curl")
                    .to_string(),
                "ffmpeg" | "httpie" | "wget" | "axel" => external_downloader.to_string(),
                "aria2c" | "aria2" => {
                    return Err("The legacy aria2 external downloader is intentionally disabled. Use curl for direct HTTP(S)/FTP or add a dedicated torrent engine.".to_string());
                }
                other => {
                    return Err(format!(
                        "Unsupported external downloader '{}'. Allowed values: native, curl, ffmpeg, httpie, wget, axel.",
                        other
                    ));
                }
            };
            push_string_arg(&mut args, "--downloader", Some(&value))?;
        }
    }
    push_string_arg(&mut args, "--downloader-args", trimmed(&media.external_downloader_args))?;
    push_string_arg(&mut args, "--download-archive", trimmed(&media.download_archive))?;
    push_bool_flag(&mut args, media.break_on_existing, "--break-on-existing", None);
    push_bool_flag(&mut args, media.force_overwrites, "--force-overwrites", Some("--no-force-overwrites"));
    push_bool_flag(&mut args, media.no_overwrites, "--no-overwrites", None);
    push_bool_flag(&mut args, media.restrict_filenames, "--restrict-filenames", Some("--no-restrict-filenames"));
    push_bool_flag(&mut args, media.windows_filenames, "--windows-filenames", Some("--no-windows-filenames"));
    if let Some(limit) = media.trim_filenames.filter(|limit| *limit > 0) {
        push_arg(&mut args, "--trim-filenames", &limit.to_string());
    }
    push_bool_flag(&mut args, media.write_comments, "--write-comments", None);
    if ffmpeg_enabled {
        push_bool_flag(&mut args, media.embed_metadata, "--embed-metadata", Some("--no-embed-metadata"));
        push_bool_flag(&mut args, media.embed_chapters, "--embed-chapters", Some("--no-embed-chapters"));
        push_string_arg(&mut args, "--convert-thumbnails", trimmed(&media.convert_thumbnails))?;
        push_string_arg(&mut args, "--postprocessor-args", trimmed(&media.postprocessor_args))?;
    }
    push_string_arg(&mut args, "--extractor-args", trimmed(&media.extractor_args))?;
    push_string_arg(&mut args, "--compat-options", trimmed(&media.compat_options))?;
    push_bool_flag(&mut args, media.live_from_start, "--live-from-start", None);
    push_string_arg(&mut args, "--wait-for-video", trimmed(&media.wait_for_video))?;
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
    push_string_arg(&mut args, "--geo-bypass-country", trimmed(&media.geo_bypass_country))?;

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

    args.push("--".to_string());
    args.push(url.to_string());
    Ok(args)
}

pub async fn create_ytdlp_task(
    state: &SharedState,
    body: &CreateDownloadBody,
) -> Result<Task, String> {
    let url = body.url.as_deref().unwrap_or("");
    let name = body.name.clone().unwrap_or_else(|| "media".to_string());
    let id = Uuid::new_v4().to_string();

    // Enforce maximum task limit to prevent memory exhaustion
    if lock_or_err!(state.task_snapshot).len() >= 10_000 {
        return Err("Maximum number of tasks reached. Complete or delete some tasks before creating new ones.".to_string());
    }

    if let Some(sp) = &body.save_path {
        if let Some(parent) = std::path::Path::new(sp).parent() {
            let dir = parent.to_string_lossy().to_string();
            if !dir.is_empty() {
                let _ = std::fs::create_dir_all(&dir);
            }
        }
    }

    if let Some(media_options) = body.media_options.as_ref() {
        engine_capabilities::validate_ytdlp_media_options(
            &state.ytdlp_bin,
            &state.ffmpeg_bin,
            &state.curl_bin,
            media_options,
        )?;
    }
    let args = build_ytdlp_args_with_engines(body, Some(&state.curl_bin), Some(&state.ffmpeg_bin))?;
    let should_start = body.start_immediately.unwrap_or(true);

    let task = Task {
        id: id.clone(),
        name,
        url: url.to_string(),
        file_type: "video".to_string(),
        status: if should_start {
            "downloading"
        } else {
            "queued"
        }
        .to_string(),
        size_bytes: 0,
        downloaded_bytes: 0,
        speed_bytes_per_sec: 0,
        time_left_seconds: 0,
        date_added: now_str(),
        category: body.category.clone().unwrap_or_else(|| "video".to_string()),
        queue_id: body.queue_id.clone().unwrap_or_else(|| "main".to_string()),
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
        }],
        referer: None,
        engine: "yt-dlp".to_string(),
        engine_id: id.clone(),
        engine_status: Some(if should_start { "starting" } else { "queued" }.to_string()),
        error_message: None,
        torrent_metadata: None,
    };

    lock_or_err!(state.media_jobs).insert(
        id.clone(),
        MediaJob {
            task: task.clone(),
            child: None,
            args,
        },
    );
    lock_or_err!(state.task_snapshot).insert(id.clone(), task.clone());
    state.mark_dirty();

    if should_start {
        start_ytdlp_process(state, &id);
    }

    Ok(task)
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
            proxy: Some("http://127.0.0.1:8080".to_string()),
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

        let args = build_ytdlp_args(&media_body(media_options)).unwrap();

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
}
