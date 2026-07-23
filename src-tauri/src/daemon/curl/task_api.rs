use std::collections::HashSet;
use std::sync::atomic::Ordering;
use uuid::Uuid;

use super::*;
use crate::daemon::direct::DirectUrl;
use crate::daemon::engine::extractor::{EngineStatus, Extractor, ValidateError};
use crate::daemon::state::SharedState;
use crate::daemon::types::{CreateDownloadBody, Task};
use crate::daemon::utils::kill_process;
use crate::lock_or_err;

const MAX_TASKS: usize = 10_000;

pub(crate) async fn create_curl_task(
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

    if let Err(integrity_error) =
        crate::daemon::engine_capabilities::validate_linked_libcurl_integrity()
    {
        log::warn!(
            "libcurl integrity discrepancy; continuing because per-download capabilities are validated separately: {integrity_error}"
        );
    }

    let direct_options = body.direct_options.clone().unwrap_or_default();
    crate::daemon::engine_capabilities::validate_curl_direct_options(
        &direct_options,
        body.resumable.unwrap_or(true),
    )?;

    if lock_or_err!(state.task_snapshot).len() >= MAX_TASKS {
        return Err("Maximum number of tasks reached. Complete or delete some tasks before creating new ones.".to_string());
    }

    let (name, output_path) = destination_from_body(body, url);
    crate::daemon::direct::FileWriter::ensure_parent(&output_path)?;
    let fail_with_body_supported =
        crate::daemon::engine_capabilities::curl_supports_flag("--fail-with-body");
    let args =
        args::build_curl_args_with_capabilities(body, &output_path, fail_with_body_supported)?;
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

pub(crate) async fn list_all_tasks(state: &SharedState) -> Vec<Task> {
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

pub(crate) async fn pause_task(state: &SharedState, id: &str) -> Result<Task, String> {
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

pub(crate) async fn resume_task(state: &SharedState, id: &str) -> Result<Task, String> {
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

/// Characters that may not appear in a file name on any supported platform
/// (Windows-reserved set is the strictest, so it is used universally).
fn sanitize_new_name(raw: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name.len() > 240 {
        return Err("Name is too long (max 240 characters)".to_string());
    }
    if name.chars().any(|c| {
        matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err(format!("Name contains forbidden characters: {}", name));
    }
    if name == "." || name == ".." {
        return Err("Invalid name".to_string());
    }
    Ok(name.to_string())
}

/// Rename the on-disk destination (completed or partial) to match a new task
/// name, keeping the original extension when the new name has none. Returns
/// the new save path on success.
fn rename_destination_on_disk(
    old_path: &std::path::Path,
    new_name: &str,
) -> Option<std::path::PathBuf> {
    let parent = old_path.parent()?;
    let mut candidate = parent.join(new_name);
    // Keep the previous extension when the user typed a bare stem.
    if candidate.extension().is_none() {
        if let Some(ext) = old_path.extension().and_then(|e| e.to_str()) {
            candidate.set_extension(ext);
        }
    }
    if candidate == old_path {
        return Some(old_path.to_path_buf());
    }
    if candidate.exists() {
        // Never clobber an existing file during rename.
        return None;
    }
    if old_path.exists() {
        std::fs::rename(old_path, &candidate).ok()?;
    }
    Some(candidate)
}

/// Clear stored conditional-request validators after the task URL changes so
/// a resume against the refreshed link does not trigger 412/304 loops.
fn clear_stale_validators(
    direct_options: &mut std::collections::HashMap<String, serde_json::Value>,
) {
    for key in ["etag", "lastModified", "digestSha256"] {
        direct_options.remove(key);
    }
}

pub(crate) async fn update_task_metadata(
    state: &SharedState,
    id: &str,
    name: Option<String>,
    url: Option<String>,
) -> Result<Task, String> {
    let new_name = match name.as_deref() {
        Some(raw) => Some(sanitize_new_name(raw)?),
        None => None,
    };
    let new_url = match url.as_deref() {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("URL cannot be empty".to_string());
            }
            Some(trimmed.to_string())
        }
        None => None,
    };
    if new_name.is_none() && new_url.is_none() {
        return Err("Nothing to update".to_string());
    }

    // Media (yt-dlp) tasks.
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if matches!(
                job.task.status.as_str(),
                "downloading" | "pausing" | "stopping"
            ) {
                return Err("Stop the download before editing it".to_string());
            }
            if let Some(ref u) = new_url {
                if !(u.starts_with("http://") || u.starts_with("https://")) {
                    return Err("Only http(s) URLs are supported for media tasks".to_string());
                }
                job.task.url = u.clone();
            }
            if let Some(ref n) = new_name {
                job.task.name = n.clone();
                if let Some(new_path) =
                    rename_destination_on_disk(std::path::Path::new(&job.task.save_path), n)
                {
                    job.task.save_path = new_path.to_string_lossy().to_string();
                }
            }
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            return Ok(task);
        }
    }

    // Direct (libcurl) tasks.
    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if matches!(
                job.task.status.as_str(),
                "downloading" | "pausing" | "stopping"
            ) {
                return Err("Stop the download before editing it".to_string());
            }
            if let Some(ref u) = new_url {
                let parsed = DirectUrl::parse(u)?;
                crate::daemon::utils::is_safe_target_url(&parsed.normalized)?;
                let old_url = std::mem::replace(&mut job.task.url, parsed.normalized.clone());
                if old_url != parsed.normalized {
                    clear_stale_validators(&mut job.direct_options);
                    if !old_url.is_empty() {
                        state.metadata_cache.remove(&old_url);
                    }
                }
            }
            if let Some(ref n) = new_name {
                job.task.name = n.clone();
                if let Some(new_path) =
                    rename_destination_on_disk(std::path::Path::new(&job.task.save_path), n)
                {
                    job.task.save_path = new_path.to_string_lossy().to_string();
                }
            }
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            return Ok(task);
        }
    }

    Err("Task not found".to_string())
}

/// Re-download a task from scratch: removes the existing output (and any
/// segment parts), resets progress, clears stale validators, and restarts.
pub(crate) async fn redownload_task(state: &SharedState, id: &str) -> Result<Task, String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.get_mut(id) {
            if let Some(pid) = job.child.take() {
                kill_process(pid);
            }
            let path = std::path::PathBuf::from(&job.task.save_path);
            if !job.task.save_path.is_empty() {
                let _ = std::fs::remove_file(&path);
            }
            job.task.status = "downloading".to_string();
            job.task.downloaded_bytes = 0;
            job.task.speed_bytes_per_sec = 0;
            job.task.time_left_seconds = 0;
            job.task.error_message = None;
            job.task.engine_status = Some("redownload-requested".to_string());
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            crate::daemon::ytdlp::start_ytdlp_process(state, id);
            return Ok(task);
        }
    }

    {
        let mut jobs = lock_or_err!(state.curl_jobs);
        if let Some(job) = jobs.get_mut(id) {
            // Cancel any running worker and invalidate its generation so a
            // late finish cannot overwrite the fresh state.
            job.cancel_token.store(true, Ordering::Release);
            job.run_generation.fetch_add(1, Ordering::Release);
            let path = std::path::PathBuf::from(&job.task.save_path);
            let _ = std::fs::remove_file(&path);
            remove_stale_parts_for(&path);
            clear_stale_validators(&mut job.direct_options);
            job.task.status = "queued".to_string();
            job.task.downloaded_bytes = 0;
            job.task.speed_bytes_per_sec = 0;
            job.task.time_left_seconds = 0;
            job.task.error_message = None;
            job.task.engine_status = Some("redownload-requested".to_string());
            job.task.segments = crate::daemon::utils::build_segments(
                job.task.connections,
                job.task.size_bytes,
                0,
                true,
                0,
            );
            let task = job.task.clone();
            drop(jobs);
            lock_or_err!(state.task_snapshot).insert(id.to_string(), task.clone());
            state.mark_dirty();
            start_curl_process(state, id);
            return Ok(task);
        }
    }

    Err("Task not found".to_string())
}

pub(crate) async fn delete_task(
    state: &SharedState,
    id: &str,
    delete_files: bool,
) -> Result<(), String> {
    {
        let mut jobs = lock_or_err!(state.media_jobs);
        if let Some(job) = jobs.remove(id) {
            if let Some(pid) = job.child {
                kill_process(pid);
            }
            let path = std::path::PathBuf::from(&job.task.save_path);
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
            let path = std::path::PathBuf::from(&job.task.save_path);
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

pub(crate) fn curl_version() -> String {
    let v = ::curl::Version::get();
    format!("libcurl {}", v.version())
}

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
        crate::daemon::engine_capabilities::validate_curl_direct_options(
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
    use crate::daemon::types::CreateDownloadBody;
    use ::curl::easy::Easy2;
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

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
        let mut direct_options = std::collections::HashMap::new();
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

        let args = build_curl_args(&body, std::path::Path::new("C:/Downloads/file.bin")).unwrap();

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
        assert!(build_curl_args(&body, std::path::Path::new("file.torrent")).is_err());
    }

    #[test]
    fn build_curl_args_accepts_browser_user_agent() {
        let mut direct_options = std::collections::HashMap::new();
        let user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) NOVA/0.1.0";
        direct_options.insert("userAgent".to_string(), serde_json::json!(user_agent));

        let mut body = base_body();
        body.direct_options = Some(direct_options);

        let args = build_curl_args(&body, std::path::Path::new("C:/Downloads/file.bin")).unwrap();

        assert!(has_pair(&args, "--user-agent", user_agent));
    }

    #[derive(Clone)]
    struct MemorySink {
        data: Arc<Mutex<Vec<u8>>>,
    }

    impl ::curl::easy::Handler for MemorySink {
        fn write(&mut self, data: &[u8]) -> Result<usize, ::curl::easy::WriteError> {
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

        let mut guard = CurlMultiGuard::new();
        let mut runtime = guard.attach_socket_runtime().unwrap();
        let handle = guard.add2(easy).unwrap();
        let handles = vec![handle];
        let cancel = AtomicBool::new(false);

        drive_multi_socket(
            guard.multi(),
            &mut runtime,
            &handles,
            &cancel,
            "transfer",
            || {},
        )
        .unwrap();

        assert_eq!(handles[0].response_code().unwrap(), 200);
        assert_eq!(*received.lock().unwrap(), expected);
        server.join().unwrap();
    }

    #[test]
    fn split_ranges_are_contiguous() {
        let ranges = split_ranges(100, 6, std::path::Path::new("file.bin"));
        assert_eq!(ranges.first().unwrap().start, 0);
        assert_eq!(ranges.last().unwrap().end, 99);
        for pair in ranges.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }
}
