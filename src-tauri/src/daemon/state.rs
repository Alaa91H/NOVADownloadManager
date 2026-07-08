use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use reqwest::Client as HttpClient;

use crate::daemon::types::{CurlJob, MediaJob, Task, TelegramConfig, TorrentConfigBody};

pub struct AppState {
    pub media_jobs: Mutex<HashMap<String, MediaJob>>,
    pub curl_jobs: Mutex<HashMap<String, CurlJob>>,
    /// Last known state of every task, kept for history and restart recovery.
    pub task_snapshot: Mutex<HashMap<String, Task>>,
    /// Set when the snapshot changed and needs flushing to disk.
    pub persist_dirty: AtomicBool,
    pub torrent_config: Mutex<TorrentConfigBody>,
    pub telegram_config: Mutex<TelegramConfig>,
    pub http_client: HttpClient,
    pub resource_dir: String,
    pub data_dir: String,
    pub curl_bin: String,
    pub ytdlp_bin: String,
    pub ffmpeg_bin: String,
    pub telegram_last_update_id: Mutex<i64>,
}

impl AppState {
    pub fn mark_dirty(&self) {
        self.persist_dirty.store(true, Ordering::Relaxed);
    }
}

pub type SharedState = Arc<AppState>;
