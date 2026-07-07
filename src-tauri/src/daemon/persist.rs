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
    #[serde(default)]
    pub telegram_last_update_id: i64,
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
                log::warn!("Corrupt downloads-state.json, starting fresh: {}", e);
                PersistedState::default()
            }
        },
        Err(_) => PersistedState::default(),
    }
}

fn build_snapshot(state: &AppState) -> PersistedState {
    let tasks: Vec<Task> = lock_or_err!(state.task_snapshot)
        .values()
        .cloned()
        .collect();
    let media_args: HashMap<String, Vec<String>> = lock_or_err!(state.media_jobs)
        .iter()
        .map(|(id, job)| (id.clone(), job.args.clone()))
        .collect();
    let curl_args: HashMap<String, Vec<String>> = lock_or_err!(state.curl_jobs)
        .iter()
        .map(|(id, job)| (id.clone(), job.args.clone()))
        .collect();
    let telegram_last_update_id = *lock_or_err!(state.telegram_last_update_id);
    PersistedState {
        version: 1,
        tasks,
        media_args,
        curl_args,
        telegram_last_update_id,
    }
}

pub fn save(state: &AppState) {
    let snapshot = build_snapshot(state);
    let path = state_file_path(&state.data_dir);
    let payload = match serde_json::to_string(&snapshot) {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to serialize download state: {}", e);
            return;
        }
    };
    // Write directly to the target path. std::fs::write atomically replaces
    // on Windows, avoiding the race condition of remove_file + rename.
    if let Err(e) = std::fs::write(&path, payload) {
        log::error!("Failed to write download state: {}", e);
    }
}

/// Periodically flush the download state to disk whenever something changed.
pub fn start_persistence_loop(state: SharedState) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if state.persist_dirty.swap(false, Ordering::Relaxed) {
                let state = state.clone();
                // File IO is small but keep it off the async executor.
                let _ = tokio::task::spawn_blocking(move || save(&state)).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::types::{CurlJob, MediaJob, Segment, TelegramConfig, TorrentConfigBody};
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::sync::{Arc, Mutex};

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
            }],
            referer: None,
            engine: engine.to_string(),
            engine_id: id.to_string(),
            engine_status: None,
            error_message: None,
            torrent_metadata: None,
        }
    }

    fn test_state(data_dir: &str) -> AppState {
        AppState {
            media_jobs: Mutex::new(HashMap::new()),
            curl_jobs: Mutex::new(HashMap::new()),
            task_snapshot: Mutex::new(HashMap::new()),
            persist_dirty: AtomicBool::new(false),
            torrent_config: Mutex::new(TorrentConfigBody {
                dht: None,
                pex: None,
                encryption: None,
                listen_port: None,
                max_peers: None,
                seeding: None,
                ratio_limit: None,
                upload_speed: None,
            }),
            telegram_config: Mutex::new(TelegramConfig::default()),
            http_client: reqwest::Client::new(),
            resource_dir: String::new(),
            data_dir: data_dir.to_string(),
            curl_bin: String::new(),
            ytdlp_bin: String::new(),
            ffmpeg_bin: String::new(),
            telegram_last_update_id: Mutex::new(0),
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("nova-persist-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.display().to_string();

        let state = test_state(&dir_str);
        state
            .task_snapshot
            .lock()
            .unwrap()
            .insert("g1".to_string(), sample_task("g1", "aria2", "downloading"));
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
            },
        );
        state.curl_jobs.lock().unwrap().insert(
            "c1".to_string(),
            CurlJob {
                task: sample_task("c1", "libcurl-multi", "downloading"),
                child: None,
                args: vec!["--location".to_string(), "https://example.com/c1".to_string()],
                direct_options: HashMap::new(),
                cancel_token: Arc::new(AtomicBool::new(false)),
                run_generation: Arc::new(AtomicU64::new(0)),
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
            Some(&vec!["--location".to_string(), "https://example.com/c1".to_string()])
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
