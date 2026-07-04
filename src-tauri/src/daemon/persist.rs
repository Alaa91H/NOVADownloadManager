use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::daemon::state::{AppState, SharedState};
use crate::daemon::types::Task;
use crate::lock_or_err;

/// On-disk snapshot of everything needed to rebuild the download list after
/// a restart: aria2 metadata, the last known state of every task, and the
/// yt-dlp argument vectors needed to resume interrupted media jobs.
#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct PersistedState {
    pub version: u32,
    pub aria2_meta: HashMap<String, HashMap<String, serde_json::Value>>,
    pub tasks: Vec<Task>,
    pub media_args: HashMap<String, Vec<String>>,
}

pub fn state_file_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("downloads-state.json")
}

pub fn aria2_session_path(data_dir: &str) -> PathBuf {
    Path::new(data_dir).join("aria2.session")
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
    let aria2_meta = lock_or_err!(state.aria2_meta).clone();
    let tasks: Vec<Task> = lock_or_err!(state.task_snapshot).values().cloned().collect();
    let media_args: HashMap<String, Vec<String>> = lock_or_err!(state.media_jobs)
        .iter()
        .map(|(id, job)| (id.clone(), job.args.clone()))
        .collect();
    PersistedState { version: 1, aria2_meta, tasks, media_args }
}

pub fn save(state: &AppState) {
    let snapshot = build_snapshot(state);
    let path = state_file_path(&state.data_dir);
    let tmp = path.with_extension("json.tmp");
    let payload = match serde_json::to_string(&snapshot) {
        Ok(p) => p,
        Err(e) => {
            log::error!("Failed to serialize download state: {}", e);
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp, payload) {
        log::error!("Failed to write download state: {}", e);
        return;
    }
    // Windows rename fails when the destination exists, so replace explicitly.
    let _ = std::fs::remove_file(&path);
    if let Err(e) = std::fs::rename(&tmp, &path) {
        log::error!("Failed to replace download state file: {}", e);
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
    use crate::daemon::types::{MediaJob, Segment, TelegramConfig, TorrentConfigBody};
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;

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
            segments: vec![Segment { id: 0, progress: 0.5, downloaded_bytes: 500, total_bytes: 1000, active: false, speed: 0 }],
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
            aria2_process: Mutex::new(None),
            media_jobs: Mutex::new(HashMap::new()),
            aria2_meta: Mutex::new(HashMap::new()),
            task_snapshot: Mutex::new(HashMap::new()),
            persist_dirty: AtomicBool::new(false),
            torrent_config: Mutex::new(TorrentConfigBody {
                dht: None, pex: None, encryption: None, listen_port: None,
                max_peers: None, seeding: None, ratio_limit: None, upload_speed: None,
            }),
            telegram_config: Mutex::new(TelegramConfig { enabled: false, token: String::new(), chat_id: 0 }),
            http_client: reqwest::Client::new(),
            resource_dir: String::new(),
            data_dir: data_dir.to_string(),
            aria2_rpc_port: 6800,
            aria2_secret: String::new(),
            aria2_bin: String::new(),
            ytdlp_bin: String::new(),
        }
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!("nova-persist-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir_str = dir.display().to_string();

        let state = test_state(&dir_str);
        state.task_snapshot.lock().unwrap().insert("g1".to_string(), sample_task("g1", "aria2", "downloading"));
        state.task_snapshot.lock().unwrap().insert("m1".to_string(), sample_task("m1", "yt-dlp", "downloading"));
        state.aria2_meta.lock().unwrap().insert("g1".to_string(), {
            let mut m = HashMap::new();
            m.insert("name".to_string(), serde_json::json!("file-g1"));
            m
        });
        state.media_jobs.lock().unwrap().insert("m1".to_string(), MediaJob {
            task: sample_task("m1", "yt-dlp", "downloading"),
            child: None,
            args: vec!["-f".to_string(), "best".to_string()],
        });

        save(&state);
        let loaded = load(&dir_str);

        assert_eq!(loaded.tasks.len(), 2);
        assert_eq!(loaded.aria2_meta.get("g1").and_then(|m| m.get("name")).and_then(|v| v.as_str()), Some("file-g1"));
        assert_eq!(loaded.media_args.get("m1"), Some(&vec!["-f".to_string(), "best".to_string()]));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_missing_or_corrupt_file_returns_default() {
        let dir = std::env::temp_dir().join(format!("nova-persist-test-corrupt-{}", std::process::id()));
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
