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
    /// arguments. They contain the effective proxy, headers, validators and
    /// DNS pinning needed to resume with the same security and behavior.
    #[serde(default)]
    pub curl_direct_options: HashMap<String, HashMap<String, serde_json::Value>>,
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
    let (media_args, curl_args, curl_direct_options, tasks, telegram_last_update_id) = {
        let media_jobs = lock_or_err!(state.media_jobs);
        let curl_jobs = lock_or_err!(state.curl_jobs);
        let snapshot = lock_or_err!(state.task_snapshot);

        let media_args: HashMap<String, Vec<String>> = media_jobs
            .iter()
            .map(|(id, job)| (id.clone(), job.args.clone()))
            .collect();
        let curl_args: HashMap<String, Vec<String>> = curl_jobs
            .iter()
            .map(|(id, job)| (id.clone(), job.args.clone()))
            .collect();
        let curl_direct_options: HashMap<String, HashMap<String, serde_json::Value>> = curl_jobs
            .iter()
            .map(|(id, job)| (id.clone(), job.direct_options.clone()))
            .collect();
        let tasks: Vec<Task> = snapshot.values().cloned().collect();
        let telegram_last_update_id = *lock_or_err!(state.telegram_last_update_id);
        (
            media_args,
            curl_args,
            curl_direct_options,
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
                args: vec!["-f".to_string(), "best".to_string()],
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
                        serde_json::Value::String("X-Resume: persisted".to_owned()),
                    );
                    options
                },
                cancel_token: Arc::new(AtomicBool::new(false)),
                run_generation: Arc::new(AtomicU64::new(0)),
                start_time: Instant::now(),
                segment_prev_bytes: Vec::new(),
                args: vec![
                    "--location".to_string(),
                    "https://example.com/c1".to_string(),
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
            loaded
                .curl_direct_options
                .get("c1")
                .and_then(|options| options.get("headers"))
                .and_then(serde_json::Value::as_str),
            Some("X-Resume: persisted")
        );

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
