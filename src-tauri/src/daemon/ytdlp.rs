use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use uuid::Uuid;

use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, MediaJob, Segment, Task};
use crate::daemon::utils::{hide_command_window, now_str};
use crate::lock_or_err;

// Only these yt-dlp flags are allowed in user-supplied extra_args.
// Any unknown `--` or `-` flag is rejected.
const ALLOWED_YTDLP_ARGS: &[&str] = &[
    "--limit-rate", "-r",
    "--retries", "-R",
    "--concurrent-fragments", "-N",
    "--format-sort", "-S",
    "--audio-quality",
    "--proxy",
    "--user-agent", "-U",
    "--cookies",
    "--sub-langs",
    "--playlist-items",
    "--remux-video",
    "--no-playlist",
    "--yes-playlist",
    "--embed-subs",
    "--write-subs",
    "--no-write-subs",
    "--embed-metadata",
    "--no-embed-metadata",
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
];

/// Flags that accept a file-system path as their value.
const PATH_VALUE_FLAGS: &[&str] = &[
    "--cookies",
    "--load-info-json",
    "--download-archive",
    "--batch-file",
];

fn is_safe_extra_arg(arg: &str) -> bool {
    if arg.is_empty() {
        return false;
    }
    // Reject shell metacharacters in any extra arg
    if arg.contains(|c: char| c == ';' || c == '|' || c == '&' || c == '$' || c == '`' || c == '\n' || c == '\r') {
        return false;
    }
    // Non-flag args (no leading `-`) are allowed as values for preceding flags
    if !arg.starts_with('-') {
        return true;
    }
    // For flags, only allow known-safe ones (whitelist approach)
    if let Some(allowed) = ALLOWED_YTDLP_ARGS.iter().find(|allowed| {
        arg == **allowed || arg.starts_with(&format!("{}=", allowed))
    }) {
        // Reject path traversal in flags that accept file paths
        if let Some(value) = arg.strip_prefix(&format!("{}=", allowed)) {
            if PATH_VALUE_FLAGS.contains(allowed) {
                if value.contains("..") {
                    log::warn!("Rejected path traversal in extra_arg: {}", arg);
                    return false;
                }
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
                        for line in reader.lines() {
                            if let Ok(line) = line {
                                if !line.is_empty() {
                                    update_ytdlp_progress(&state2, &id2, &line);
                                }
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
                                current.task.engine_status = Some(format!("exit-{}", status.map_or(-1, |s| s.code().unwrap_or(-1))));
                                notif = format!("Download failed: {}", task_name);
                            }
                        }
                    }
                    state2.mark_dirty();
                    if !notif.is_empty() {
                        let (token, enabled, chat_id, api_base) = {
                            let cfg = lock_or_err!(state2.telegram_config);
                            (cfg.token.clone(), cfg.enabled, cfg.chat_id, cfg.api_base.clone())
                        };
                        if enabled && !token.is_empty() && chat_id != 0 {
                            crate::daemon::telegram::send_telegram_msg_blocking_with_api(&api_base, &token, chat_id, &notif);
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
            if let Some(name) = std::path::Path::new(dest.trim()).file_name().and_then(|n| n.to_str()) {
                record.task.name = name.to_string();
            }
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
    let (num_str, unit) = s.split_at(s.len().saturating_sub(2));
    let num: f64 = num_str.trim().parse().ok()?;
    match unit.trim() {
        "KB" | "KiB" => Some((num * 1024.0) as u64),
        "MB" | "MiB" => Some((num * 1024.0 * 1024.0) as u64),
        "GB" | "GiB" => Some((num * 1024.0 * 1024.0 * 1024.0) as u64),
        "TB" | "TiB" => Some((num * 1024.0 * 1024.0 * 1024.0 * 1024.0) as u64),
        "B " | "B" => Some(num as u64),
        _ => s.parse::<f64>().ok().map(|n| n as u64),
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

pub async fn create_ytdlp_task(state: &SharedState, body: &CreateDownloadBody) -> Result<Task, String> {
    let url = body.url.as_deref().unwrap_or("");
    let media = body.media_options.as_ref().ok_or_else(|| "Missing media_options for yt-dlp task".to_string())?;
    let name = body.name.clone().unwrap_or_else(|| "media".to_string());
    let id = Uuid::new_v4().to_string();

    let mut args = vec![
        "--no-colors".to_string(),
        "--no-progress".to_string(),
        "--newline".to_string(),
        "--progress-template".to_string(),
        "stdout:[download] %(progress.downloaded_bytes)s of %(progress.total_bytes)s at %(progress.speed)s ETA %(progress.eta)s".to_string(),
        "-o".to_string(),
        media.output_template.clone().unwrap_or_else(|| "%(title)s.%(ext)s".to_string()),
        "--print".to_string(),
        format!("after_move:Destination: {}", media.output_template.clone().unwrap_or_else(|| "%(title)s.%(ext)s".to_string())),
    ];

    if let Some(sp) = &body.save_path {
        if let Some(parent) = std::path::Path::new(sp).parent() {
            let dir = parent.to_string_lossy().to_string();
            if !dir.is_empty() {
                args.push("-P".to_string());
                args.push(dir.clone());
                args.push("--output".to_string());
                args.push(format!("{}/{}", dir, media.output_template.clone().unwrap_or_else(|| "%(title)s.%(ext)s".to_string())));
                let _ = std::fs::create_dir_all(&dir);
            }
        }
    }

    match media.mode.as_deref() {
        Some("audio") => {
            args.push("-x".to_string());
            args.push("--audio-format".to_string());
            args.push(media.audio_format.clone().unwrap_or_else(|| "mp3".to_string()));
            if let Some(bitrate) = &media.bitrate {
                args.push("--audio-quality".to_string());
                args.push(bitrate.clone());
            }
        }
        _ => {
            let fmt = media.format_selector.clone().unwrap_or_else(|| "bv*+ba/b".to_string());
            args.push("-f".to_string());
            args.push(fmt);
            if let Some(fs) = &media.format_sort {
                args.push("--format-sort".to_string());
                args.push(fs.clone());
            }
        }
    }

    if let Some(q) = &media.quality {
        if q != "best" && !q.is_empty() {
            args.push("-f".to_string());
            args.push(format!("bv*[height<={}]+ba/b[height<={}]", q, q));
        }
    }

    if media.subtitles.unwrap_or(false) {
        args.push("--write-subs".to_string());
        args.push("--sub-langs".to_string());
        args.push(media.subtitle_languages.clone().unwrap_or_else(|| "en".to_string()));
        args.push("--embed-subs".to_string());
    }

    if media.playlist.unwrap_or(false) {
        if let Some(items) = &media.playlist_items {
            args.push("--playlist-items".to_string());
            args.push(items.clone());
        }
    } else {
        args.push("--no-playlist".to_string());
    }

    if let Some(proxy) = &media.proxy {
        if !proxy.is_empty() {
            args.push("--proxy".to_string());
            args.push(proxy.clone());
        }
    }
    if let Some(cookies) = &media.cookies {
        if !cookies.is_empty() {
            args.push("--cookies".to_string());
            args.push(cookies.clone());
        }
    }
    if let Some(ua) = &media.user_agent {
        if !ua.is_empty() {
            args.push("--user-agent".to_string());
            args.push(ua.clone());
        }
    }

    if let Some(rl) = media.rate_limit_kbs {
        if rl > 0 {
            args.push("--limit-rate".to_string());
            args.push(format!("{}K", rl));
        }
    }
    if let Some(r) = media.retries {
        args.push("--retries".to_string());
        args.push(r.to_string());
    }
    if let Some(cf) = media.concurrent_fragments {
        if cf > 0 {
            args.push("--concurrent-fragments".to_string());
            args.push(cf.to_string());
        }
    }
    if let Some(rm) = &media.remux_format {
        if !rm.is_empty() {
            args.push("--remux-video".to_string());
            args.push(rm.clone());
        }
    }
    if let Some(ea) = &media.extra_args {
        let mut rejected = Vec::new();
        for arg in ea.split_whitespace() {
            if is_safe_extra_arg(arg) {
                args.push(arg.to_string());
            } else {
                rejected.push(arg.to_string());
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

    if url.starts_with('-') {
        return Err("Invalid url: must not start with '-'".to_string());
    }
    args.push(url.to_string());

    let task = Task {
        id: id.clone(),
        name,
        url: url.to_string(),
        file_type: "video".to_string(),
        status: "downloading".to_string(),
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
        segments: vec![Segment { id: 0, progress: 0.0, downloaded_bytes: 0, total_bytes: 0, active: true, speed: 0 }],
        referer: None,
        engine: "yt-dlp".to_string(),
        engine_id: id.clone(),
        engine_status: Some("starting".to_string()),
        error_message: None,
        torrent_metadata: None,
    };

    lock_or_err!(state.media_jobs).insert(id.clone(), MediaJob {
        task: task.clone(),
        child: None,
        args,
    });
    state.mark_dirty();

    start_ytdlp_process(state, &id);

    Ok(task)
}
