use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use crate::daemon::persist::DownloadStats;

use crate::daemon::engine::adaptive_connections::AdaptiveConnectionManager;
use crate::daemon::engine::bandwidth::BandwidthManager;
use crate::daemon::engine::dynamic_segments::DynamicSegmentScheduler;
use crate::daemon::engine::event_bus::EventBus;
use crate::daemon::engine::extractor::SharedExtractorRegistry;
use crate::daemon::engine::metadata_cache::MetadataCache;
use crate::daemon::engine::mirror::MirrorManager;
use crate::daemon::engine::plugin_api::PluginApi;
use crate::daemon::engine::priority_queue::PriorityBandwidthQueue;
use crate::daemon::engine::profiles::ProfileManager;
use crate::daemon::engine::retry::RetryPolicy;
use crate::daemon::engine::retry::RetryState;
use crate::daemon::engine::rules::DownloadRuleEngine;
use crate::daemon::engine::scheduler::SmartScheduler;
use crate::daemon::types::{CurlJob, MediaJob, Task, TelegramConfig};

/// Live engine-side tracking for one running download: adaptive connection
/// tuning plus (for segmented transfers) dynamic segment accounting.
pub struct TaskEngineTracker {
    pub adaptive: AdaptiveConnectionManager,
    pub segments: Option<DynamicSegmentScheduler>,
    pub retry_state: RetryState,
}

const ENGINE_CACHE_TTL_SECS: u64 = 120;

pub struct AppState {
    pub media_jobs: Mutex<HashMap<String, MediaJob>>,
    pub curl_jobs: Mutex<HashMap<String, CurlJob>>,
    pub task_snapshot: Mutex<HashMap<String, Task>>,
    pub persist_dirty: AtomicBool,
    pub telegram_config: Mutex<TelegramConfig>,
    pub http_client: HttpClient,
    pub resource_dir: String,
    pub data_dir: String,
    pub ytdlp_bin: String,
    pub ffmpeg_bin: String,
    pub telegram_last_update_id: Mutex<i64>,
    pub engine_capabilities_cache: RwLock<Option<(Arc<serde_json::Value>, Instant)>>,
    pub task_generation: AtomicU64,
    pub task_list_cache: RwLock<Option<(u64, Arc<Vec<Task>>)>>,
    pub event_bus: EventBus,
    pub priority_queue: PriorityBandwidthQueue,
    pub bandwidth_manager: BandwidthManager,
    pub profile_manager: ProfileManager,
    pub rule_engine: DownloadRuleEngine,
    pub scheduler: SmartScheduler,
    pub metadata_cache: MetadataCache,
    pub default_retry_policy: RwLock<RetryPolicy>,
    pub plugin_api: PluginApi,
    pub engine_trackers: Mutex<HashMap<String, TaskEngineTracker>>,
    pub mirror_managers: Mutex<HashMap<String, MirrorManager>>,
    /// Registry of download extractors (curl, yt-dlp, etc.)
    pub extractor_registry: SharedExtractorRegistry,
    /// Bearer token for API authentication. Generated at daemon start.
    pub api_token: String,
    /// Accumulated download statistics persisted across sessions.
    pub download_stats: Mutex<DownloadStats>,
}

impl AppState {
    pub fn mark_dirty(&self) {
        self.persist_dirty.store(true, Ordering::Release);
        self.task_generation.fetch_add(1, Ordering::Release);
    }

    pub fn engine_capabilities(&self) -> Arc<serde_json::Value> {
        if let Ok(cache) = self.engine_capabilities_cache.read() {
            if let Some((ref value, ref ts)) = *cache {
                if ts.elapsed().as_secs() < ENGINE_CACHE_TTL_SECS {
                    return value.clone();
                }
            }
        }
        let result = crate::daemon::engine_capabilities::all_engine_status(
            &self.ytdlp_bin,
            &self.ffmpeg_bin,
        );
        let arc_result = Arc::new(result);
        if let Ok(mut cache) = self.engine_capabilities_cache.write() {
            *cache = Some((arc_result.clone(), Instant::now()));
        }
        arc_result
    }
}

pub type SharedState = Arc<AppState>;
