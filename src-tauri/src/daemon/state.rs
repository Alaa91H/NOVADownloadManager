use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;
use reqwest::Client as HttpClient;

use crate::daemon::types::{CurlJob, MediaJob, Task, TelegramConfig, TorrentConfigBody};

const ENGINE_CACHE_TTL_SECS: u64 = 30;

pub struct AppState {
    pub media_jobs: Mutex<HashMap<String, MediaJob>>,
    pub curl_jobs: Mutex<HashMap<String, CurlJob>>,
    pub task_snapshot: Mutex<HashMap<String, Task>>,
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
    pub engine_capabilities_cache: Mutex<Option<(serde_json::Value, Instant)>>,
}

impl AppState {
    pub fn mark_dirty(&self) {
        self.persist_dirty.store(true, Ordering::Relaxed);
    }

    pub fn engine_capabilities(&self) -> serde_json::Value {
        if let Ok(cache) = self.engine_capabilities_cache.lock() {
            if let Some((ref value, ref ts)) = *cache {
                if ts.elapsed().as_secs() < ENGINE_CACHE_TTL_SECS {
                    return value.clone();
                }
            }
        }
        let result = crate::daemon::engine_capabilities::all_engine_status(
            &self.curl_bin, &self.ytdlp_bin, &self.ffmpeg_bin,
        );
        if let Ok(mut cache) = self.engine_capabilities_cache.lock() {
            *cache = Some((result.clone(), Instant::now()));
        }
        result
    }

    #[allow(dead_code)]
    pub fn invalidate_engine_cache(&self) {
        if let Ok(mut cache) = self.engine_capabilities_cache.lock() {
            *cache = None;
        }
    }
}

pub type SharedState = Arc<AppState>;
