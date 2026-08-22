use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::daemon::state::{AppState, SharedState};
use crate::daemon::types::Task;
use crate::lock_or_err;

/// On-disk snapshot of everything needed to rebuild the download list after
/// a restart: the last known task state plus the argument vectors needed to
/// resume interrupted curl and yt-dlp jobs.
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct PersistedState {
    pub version: u32,
    pub tasks: Vec<Task>,
    pub media_args: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub curl_args: HashMap<String, Vec<String>>,
    /// Per-task libcurl options are persisted separately from diagnostic CLI
    /// arguments. Authentication-bearing options are removed before writing
    /// this state, while non-sensitive validators and DNS settings remain
    /// available for safe resume.
    #[serde(default)]
    pub curl_direct_options: HashMap<String, HashMap<String, serde_json::Value>>,
    /// Tasks whose authenticated request material was intentionally omitted
    /// from disk. They need a fresh user-authorized download request after a
    /// restart instead of a best-effort resume with missing credentials.
    #[serde(default)]
    pub resume_requires_reauth: Vec<String>,
    #[serde(default)]
    pub telegram_last_update_id: i64,
    #[serde(default)]
    pub scheduler_rules: Vec<crate::daemon::engine::scheduler::SchedulerRule>,
    #[serde(default)]
    pub stats: DownloadStats,
}

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct DownloadStats {
    pub total_downloaded_bytes: u64,
    pub total_completed: u64,
    pub total_failed: u64,
    pub session_started_at: Option<String>,
}

pub fn state_file_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("downloads-state.json")
}

/// Arguments that can contain credentials, session cookies, authentication
/// material, or proxy credentials. They must never be copied into the JSON
/// resume snapshot because the snapshot is readable as a regular local file.
const SENSITIVE_RESUME_ARGUMENT_FLAGS: &[&str] = &[
    "--add-header",
    "--cookie",
    "--cookie-jar",
    "--cookies",
    "--cookies-from-browser",
    "--header",
    "--netrc",
    "--oauth2-bearer",
    "--password",
    "--preproxy",
    "--proxy",
    "--referer",
    "--twofactor",
    "--user",
    "--username",
    "-H",
    "-u",
];

/// Keys in direct-download configuration that can disclose authenticated
/// sessions or credentials. The request still uses them in memory, but an
/// interrupted authenticated download must be re-authorized instead of
/// writing its credentials to `downloads-state.json`.
const SENSITIVE_DIRECT_OPTION_KEYS: &[&str] = &[
    "cookies", "headers", "password", "proxy", "preproxy", "referer", "username",
];

fn is_sensitive_resume_argument(arg: &str) -> bool {
    // curl accepts both `-u user:password` and the attached `-uuser:password`
    // form (likewise `-HHeader: value`). Treat both forms as secret-bearing.
    if (arg.starts_with("-u") || arg.starts_with("-H")) && arg.len() > 2 {
        return true;
    }

    SENSITIVE_RESUME_ARGUMENT_FLAGS.iter().any(|flag| {
        arg == *flag
            || arg
                .strip_prefix(flag)
                .is_some_and(|suffix| suffix.starts_with('='))
    })
}

/// Returns a copy of an argument vector without credential-bearing options.
///
/// The following value is removed for flags that take a value. Boolean flags
/// such as `--netrc` are removed on their own. This deliberately favors
/// confidentiality over unattended resume for authenticated downloads.
fn sanitize_resume_args(args: &[String]) -> Vec<String> {
    let mut sanitized = Vec::with_capacity(args.len());
    let mut skip_next = false;

    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if is_sensitive_resume_argument(arg) {
            if !arg.contains('=') && arg != "--netrc" {
                skip_next = true;
            }
            continue;
        }
        sanitized.push(arg.clone());
    }

    sanitized
}

fn direct_options_require_reauth(options: &HashMap<String, serde_json::Value>) -> bool {
    options
        .keys()
        .any(|key| SENSITIVE_DIRECT_OPTION_KEYS.contains(&key.as_str()))
}

fn sanitize_direct_options(
    options: &HashMap<String, serde_json::Value>,
) -> HashMap<String, serde_json::Value> {
    options
        .iter()
        .filter(|(key, _)| !SENSITIVE_DIRECT_OPTION_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub fn load(data_dir: &str) -> PersistedState {
    let path = state_file_path(data_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(parsed) => parsed,
            Err(e) => {
                log::warn!("Corrupt downloads-state.json, starting fresh: {e}");
                // Preserve the corrupt file for diagnostics instead of
                // silently overwriting it on the next save.
                let backup = path.with_extension("json.corrupt");
                if let Err(copy_err) = std::fs::copy(&path, &backup) {
                    log::warn!("Failed to back up corrupt state file: {copy_err}");
                }
                PersistedState::default()
            }
        },
        Err(_) => PersistedState::default(),
    }
}

fn build_snapshot(state: &AppState) -> PersistedState {
    // Acquire locks in documented order (media_jobs → curl_jobs → task_snapshot)
    // within a block scope so curl_jobs is released before download_stats,
    // preventing AB-BA deadlock with transfer.rs (which locks download_stats → curl_jobs).
    let (
        media_args,
        curl_args,
        curl_direct_options,
        resume_requires_reauth,
        tasks,
        telegram_last_update_id,
    ) = {
        let media_jobs = lock_or_err!(state.media_jobs);
        let curl_jobs = lock_or_err!(state.curl_jobs);
        let snapshot = lock_or_err!(state.task_snapshot);

        let media_args: HashMap<String, Vec<String>> = media_jobs
            .iter()
            .map(|(id, job)| (id.clone(), sanitize_resume_args(&job.args)))
            .collect();
        let curl_args: HashMap<String, Vec<String>> = curl_jobs
            .iter()
            .map(|(id, job)| (id.clone(), sanitize_resume_args(&job.args)))
            .collect();
        let curl_direct_options: HashMap<String, HashMap<String, serde_json::Value>> = curl_jobs
            .iter()
            .map(|(id, job)| (id.clone(), sanitize_direct_options(&job.direct_options)))
            .collect();
        let mut resume_requires_reauth: Vec<String> = media_jobs
            .iter()
            .filter(|(_, job)| job.args.iter().any(|arg| is_sensitive_resume_argument(arg)))
            .map(|(id, _)| id.clone())
            .collect();
        resume_requires_reauth.extend(
            curl_jobs
                .iter()
                .filter(|(_, job)| {
                    job.args.iter().any(|arg| is_sensitive_resume_argument(arg))
                        || direct_options_require_reauth(&job.direct_options)
                })
                .map(|(id, _)| id.clone()),
        );
        resume_requires_reauth.sort();
        resume_requires_reauth.dedup();
        let tasks: Vec<Task> = snapshot.values().cloned().collect();
        let telegram_last_update_id = *lock_or_err!(state.telegram_last_update_id);
        (
            media_args,
            curl_args,
            curl_direct_options,
            resume_requires_reauth,
            tasks,
            telegram_last_update_id,
        )
    };
    let scheduler_rules = state.scheduler.rules();
    let stats = lock_or_err!(state.download_stats).clone();

    PersistedState {
        version: 1,
        tasks,
        media_args,
        curl_args,
        curl_direct_options,
        resume_requires_reauth,
        telegram_last_update_id,
        scheduler_rules,
        stats,
    }
}

/// Returns `true` on success, `false` on failure (caller should retry).
pub fn save(state: &AppState) -> bool {
    let snapshot = build_snapshot(state);
    let path = state_file_path(&state.data_dir);
    let payload = match serde_json::to_string(&snapshot) {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to serialize download state: {e}");
            return false;
        }
    };
    let tmp_path = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp_path, &payload) {
        log::error!("Failed to write temporary state file: {e}");
        return false;
    }
    match std::fs::File::open(&tmp_path) {
        Ok(f) => {
            if let Err(e) = f.sync_all() {
                log::warn!("Failed to sync temporary state file to disk: {e}");
            }
        }
        Err(e) => {
            log::error!("Failed to open temporary state file for fsync: {e}");
            let _ = std::fs::remove_file(&tmp_path);
            return false;
        }
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        log::error!("Failed to rename state file into place: {e}");
        let _ = std::fs::remove_file(&tmp_path);
        return false;
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    true
}

/// Immediately persist the download state (used during graceful shutdown).
pub fn save_now(state: &AppState) {
    if !save(state) {
        log::error!("Failed to persist download state during shutdown");
    }
}

/// Periodically flush the download state to disk whenever something changed.
///
/// Uses an adaptive checkpoint interval:
///   - **60 s** baseline when the system is idle (no active downloads).
///   - **10 s** when one or more downloads are running, so crash recovery
///     loses at most 10 s of progress — long enough to keep rapid progress
///     updates from amplifying SSD writes.
///   - The dirty flag still gates actual writes — the interval only controls
///     how often we *check*.
pub fn start_persistence_loop(state: SharedState) {
    tokio::spawn(async move {
        const BASELINE_SECS: u64 = 60;
        const ACTIVE_SECS: u64 = 10;

        loop {
            let has_active = {
                let snap = lock_or_err!(state.task_snapshot);
                snap.values().any(|t| {
                    t.status == "downloading" || t.status == "pausing" || t.status == "stopping"
                })
            };
            let interval = if has_active {
                ACTIVE_SECS
            } else {
                BASELINE_SECS
            };

            tokio::time::sleep(Duration::from_secs(interval)).await;
            if state.persist_dirty.swap(false, Ordering::Acquire) {
                let state_clone = state.clone();
                let result = tokio::task::spawn_blocking(move || save(&state_clone)).await;
                // If save failed (or panicked), re-arm the dirty flag so the
                // next loop iteration retries — otherwise the changed state
                // would be silently lost forever.
                match result {
                    Ok(false) => {
                        state.persist_dirty.store(true, Ordering::Release);
                    }
                    Err(join_err) => {
                        log::error!("Persistence task panicked; will retry: {join_err}");
                        state.persist_dirty.store(true, Ordering::Release);
                    }
                    _ => {}
                }
            }
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::daemon::types::{CurlJob, MediaJob, Segment, TelegramConfig};
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::{Arc, Mutex, RwLock};
    use std::time::Instant;

    fn sample_task(id: &str, engine: &str, status: &str) -> Task {
        Task {
            id: id.to_string(),
            name: format!("file-{}", id),
            url: format!("https://example.com/{}", id),
            file_type: "other".to_string(),
            status: status.to_string(),
            size_bytes: 1000,
            downloaded_bytes: 500,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 0,
            date_added: "2026-07-03".to_string(),
            category: "other".to_string(),
            queue_id: "main".to_string(),
            connections: 1,
            resumable: true,
            save_path: format!("C:/downloads/{}", id),
            description: "test".to_string(),
            segments: vec![Segment {
                id: 0,
                progress: 0.5,
                downloaded_bytes: 500,
                total_bytes: 1000,
                active: false,
                speed: 0,
                start_byte: 0,
                end_byte: 1000,
            }],
            referer: None,
            engine: engine.to_string(),
            engine_id: id.to_string(),
            engine_status: None,
            error_message: None,
        }
    }

    pub(crate) fn test_state(data_dir: &str) -> AppState {
        AppState {
            media_jobs: Mutex::new(HashMap::new()),
            curl_jobs: Mutex::new(HashMap::new()),
            task_snapshot: Mutex::new(HashMap::new()),
            capture_reviews: Mutex::new(std::collections::VecDeque::new()),
            persist_dirty: AtomicBool::new(false),
            telegram_config: Mutex::new(TelegramConfig::default()),
            http_client: reqwest::Client::new(),
            resource_dir: String::new(),
            data_dir: data_dir.to_string(),
            ytdlp_bin: RwLock::new(String::new()),
            ffmpeg_bin: RwLock::new(String::new()),
            bundled_ytdlp_bin: String::new(),
            bundled_ffmpeg_bin: String::new(),
            telegram_last_update_id: Mutex::new(0),
            engine_capabilities_cache: RwLock::new(None),
            engine_capabilities_probe: std::sync::Mutex::new(()),
            task_generation: AtomicU64::new(0),
            task_list_cache: RwLock::new(None),
            event_bus: crate::daemon::engine::event_bus::EventBus::new_with_capacity(100),
            priority_queue: crate::daemon::engine::priority_queue::PriorityBandwidthQueue::new(0),
            bandwidth_manager: crate::daemon::engine::bandwidth::BandwidthManager::default(),
            profile_manager: crate::daemon::engine::profiles::ProfileManager::new(),
            rule_engine: crate::daemon::engine::rules::DownloadRuleEngine::new(),
            scheduler: crate::daemon::engine::scheduler::SmartScheduler::new(),
            metadata_cache: crate::daemon::engine::metadata_cache::MetadataCache::with_ttl(
                std::time::Duration::from_secs(3600),
            ),
            default_retry_policy: RwLock::new(
                crate::daemon::engine::config::global_config().retry_policy(),
            ),
            plugin_api: crate::daemon::engine::plugin_api::PluginApi::new(),
            engine_trackers: RwLock::new(HashMap::new()),
            mirror_managers: Mutex::new(HashMap::new()),
            extractor_registry: crate::daemon::engine::extractor::SharedExtractorRegistry::new(
                crate::daemon::engine::extractor::ExtractorRegistry::new(),
            ),
            api_token: String::new(),
            download_stats: Mutex::new(DownloadStats::default()),
            rie: crate::daemon::resource_intelligence::ResourceIntelligenceEngine::new(),
            external_tools: std::sync::Arc::new(std::sync::Mutex::new(
                crate::daemon::external_tools::ExternalToolManager::new(
                    data_dir,
                    reqwest::Client::new(),
                ),
            )),
            policy_engine: std::sync::Arc::new(std::sync::Mutex::new(
                crate::daemon::engine::policy_engine::PolicyEngine::new(),
            )),
            self_healer: {
                let pe = std::sync::Arc::new(std::sync::Mutex::new(
                    crate::daemon::engine::policy_engine::PolicyEngine::new(),
                ));
                std::sync::Arc::new(std::sync::Mutex::new(
                    crate::daemon::engine::self_healing::SelfHealer::new(pe),
                ))
            },
            die_orchestrator: std::sync::Arc::new(std::sync::Mutex::new(
                crate::daemon::engine::die_orchestrator::DieOrchestrator::new(),
            )),
            resource_manager: std::sync::Arc::new(std::sync::Mutex::new(
                crate::daemon::engine::resource_manager::ResourceManager::new(),
            )),
            shutdown_requested: std::sync::atomic::AtomicBool::new(false),
            watchdog_handles: std::sync::Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("nova-persist-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.display().to_string();

        let state = test_state(&dir_str);
        state.task_snapshot.lock().unwrap().insert(
            "g1".to_string(),
            sample_task("g1", "libcurl-multi", "downloading"),
        );
        state
            .task_snapshot
            .lock()
            .unwrap()
            .insert("m1".to_string(), sample_task("m1", "yt-dlp", "downloading"));
        state
            .task_snapshot
            .lock()
            .unwrap()
            .insert("c1".to_string(), sample_task("c1", "curl", "downloading"));
        state.media_jobs.lock().unwrap().insert(
            "m1".to_string(),
            MediaJob {
                task: sample_task("m1", "yt-dlp", "downloading"),
                child: None,
                args: vec![
                    "-f".to_string(),
                    "best".to_string(),
                    "--username".to_string(),
                    "private-user".to_string(),
                    "--password=private-password".to_string(),
                    "--add-header".to_string(),
                    "Cookie: session=private-cookie".to_string(),
                ],
                start_time: Instant::now(),
            },
        );
        state.curl_jobs.lock().unwrap().insert(
            "c1".to_string(),
            CurlJob {
                task: sample_task("c1", "libcurl-multi", "downloading"),
                direct_options: {
                    let mut options = HashMap::new();
                    options.insert(
                        "headers".to_owned(),
                        serde_json::Value::String("Authorization: Bearer private-token".to_owned()),
                    );
                    options.insert(
                        "cookies".to_owned(),
                        serde_json::Value::String("session=private-cookie".to_owned()),
                    );
                    options.insert("retries".to_owned(), serde_json::Value::Number(3.into()));
                    options
                },
                cancel_token: Arc::new(AtomicBool::new(false)),
                run_generation: Arc::new(AtomicU64::new(0)),
                start_time: Instant::now(),
                segment_prev_bytes: Vec::new(),
                args: vec![
                    "--location".to_string(),
                    "https://example.com/c1".to_string(),
                    "--user".to_string(),
                    "private-user:private-password".to_string(),
                    "-uprivate-user:private-password".to_string(),
                    "-HAuthorization: Bearer private-token".to_string(),
                ],
            },
        );

        save(&state);
        let loaded = load(&dir_str);

        assert_eq!(loaded.tasks.len(), 3);
        assert_eq!(
            loaded.media_args.get("m1"),
            Some(&vec!["-f".to_string(), "best".to_string()])
        );
        assert_eq!(
            loaded.curl_args.get("c1"),
            Some(&vec![
                "--location".to_string(),
                "https://example.com/c1".to_string()
            ])
        );
        assert_eq!(
            loaded.resume_requires_reauth,
            vec!["c1".to_string(), "m1".to_string()]
        );
        let direct_options = loaded.curl_direct_options.get("c1").unwrap();
        assert_eq!(
            direct_options.get("retries"),
            Some(&serde_json::Value::Number(3.into()))
        );
        assert!(!direct_options.contains_key("headers"));
        assert!(!direct_options.contains_key("cookies"));
        let persisted = std::fs::read_to_string(state_file_path(&dir_str)).unwrap();
        for secret in [
            "private-user",
            "private-password",
            "private-cookie",
            "private-token",
        ] {
            assert!(
                !persisted.contains(secret),
                "persisted state leaked {secret}"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_missing_or_corrupt_file_returns_default() {
        let dir =
            std::env::temp_dir().join(format!("nova-persist-test-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.display().to_string();

        let loaded = load(&dir_str);
        assert!(loaded.tasks.is_empty());

        std::fs::write(state_file_path(&dir_str), "{not valid json").unwrap();
        let loaded = load(&dir_str);
        assert!(loaded.tasks.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
