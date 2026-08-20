use reqwest::Client as HttpClient;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use std::time::Instant;

use crate::daemon::external_tools::types::ToolId;
use crate::daemon::external_tools::ExternalToolManager;
use crate::daemon::persist::DownloadStats;
use crate::daemon::resource_intelligence::ResourceIntelligenceEngine;

use crate::daemon::engine::adaptive::AdaptiveEngine;
use crate::daemon::engine::adaptive_connections::AdaptiveConnectionManager;
use crate::daemon::engine::bandwidth::BandwidthManager;
use crate::daemon::engine::die_orchestrator::DieOrchestrator;
use crate::daemon::engine::dynamic_segments::DynamicSegmentScheduler;
use crate::daemon::engine::event_bus::EventBus;
use crate::daemon::engine::extractor::SharedExtractorRegistry;
use crate::daemon::engine::metadata_cache::MetadataCache;
use crate::daemon::engine::mirror::MirrorManager;
use crate::daemon::engine::plugin_api::PluginApi;
use crate::daemon::engine::policy_engine::PolicyEngine;
use crate::daemon::engine::priority_queue::PriorityBandwidthQueue;
use crate::daemon::engine::profiles::ProfileManager;
use crate::daemon::engine::resource_manager::ResourceManager;
use crate::daemon::engine::retry::RetryPolicy;
use crate::daemon::engine::retry::RetryState;
use crate::daemon::engine::rules::DownloadRuleEngine;
use crate::daemon::engine::scheduler::SmartScheduler;
use crate::daemon::engine::self_healing::SelfHealer;
use crate::daemon::types::{CurlJob, MediaJob, Task, TelegramConfig};

/// Live engine-side tracking for one running download: adaptive connection
/// tuning plus (for segmented transfers) dynamic segment accounting.
pub struct TaskEngineTracker {
    pub adaptive: AdaptiveConnectionManager,
    pub segments: Option<DynamicSegmentScheduler>,
    pub retry_state: RetryState,
    pub adaptive_engine: Mutex<Option<AdaptiveEngine>>,
}

const ENGINE_CACHE_TTL_SECS: u64 = 120;

/// Lock ordering (acquire in this order to prevent deadlocks):
///   1. `media_jobs`
///   2. `curl_jobs`
///   3. `task_snapshot`
///   4. `engine_trackers`
///   5. `mirror_managers`
///   6. `telegram_config` / `telegram_last_update_id`
///   7. `download_stats`
///   8. `watchdog_handles`
///   9. `external_tools`
///  10. `policy_engine` / `self_healer` / `die_orchestrator` / `resource_manager`
///
/// Never acquire a lower-numbered lock while holding a higher-numbered one.
pub struct AppState {
    pub media_jobs: Mutex<HashMap<String, MediaJob>>,
    pub curl_jobs: Mutex<HashMap<String, CurlJob>>,
    pub task_snapshot: Mutex<HashMap<String, Task>>,
    pub persist_dirty: AtomicBool,
    pub telegram_config: Mutex<TelegramConfig>,
    pub http_client: HttpClient,
    pub resource_dir: String,
    pub data_dir: String,
    /// Active media-engine paths. These may be replaced after NOVA verifies a
    /// managed installation, so every new media operation observes the current
    /// binary without requiring a daemon restart.
    pub ytdlp_bin: RwLock<String>,
    pub ffmpeg_bin: RwLock<String>,
    /// Bundled/fallback paths resolved at daemon startup. These are restored
    /// if a NOVA-managed binary is removed or fails a later health check.
    pub bundled_ytdlp_bin: String,
    pub bundled_ffmpeg_bin: String,
    pub telegram_last_update_id: Mutex<i64>,
    pub engine_capabilities_cache: RwLock<Option<(Arc<serde_json::Value>, Instant)>>,
    /// Serializes the subprocess probe in `engine_capabilities()` so concurrent
    /// requests cannot each spawn redundant yt-dlp/ffmpeg probes.
    pub engine_capabilities_probe: Mutex<()>,
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
    pub engine_trackers: RwLock<HashMap<String, TaskEngineTracker>>,
    pub mirror_managers: Mutex<HashMap<String, MirrorManager>>,
    /// Registry of download extractors (curl, yt-dlp, etc.)
    pub extractor_registry: SharedExtractorRegistry,
    /// Bearer token for API authentication. Generated at daemon start.
    pub api_token: String,
    /// Accumulated download statistics persisted across sessions.
    pub download_stats: Mutex<DownloadStats>,
    /// Resource Intelligence Engine — analyzes URLs and selects download strategies.
    pub rie: ResourceIntelligenceEngine,
    /// External Tool Manager — manages `FFmpeg`, yt-dlp, and other external tools.
    pub external_tools: Arc<Mutex<ExternalToolManager>>,
    /// Policy Engine — central decision layer for all runtime decisions.
    pub policy_engine: Arc<Mutex<PolicyEngine>>,
    /// Self-Healing subsystem — auto-recovery for all failure modes.
    pub self_healer: Arc<Mutex<SelfHealer>>,
    /// Die Orchestrator — host-level connection coordination and profile-driven limits.
    pub die_orchestrator: Arc<Mutex<DieOrchestrator>>,
    /// Resource Manager — unified memory/disk/thread pressure monitoring.
    pub resource_manager: Arc<Mutex<ResourceManager>>,
    /// Signal for watchdog threads to exit during daemon shutdown.
    pub shutdown_requested: AtomicBool,
    /// Join handles for watchdog threads, joined on daemon shutdown.
    pub watchdog_handles: Mutex<Vec<JoinHandle<()>>>,
}

impl AppState {
    pub fn mark_dirty(&self) {
        self.persist_dirty.store(true, Ordering::Release);
        self.task_generation.fetch_add(1, Ordering::Release);
    }

    pub fn ytdlp_binary(&self) -> String {
        self.ytdlp_bin
            .read()
            .map(|path| path.clone())
            .unwrap_or_else(|poison| poison.into_inner().clone())
    }

    pub fn ffmpeg_binary(&self) -> String {
        self.ffmpeg_bin
            .read()
            .map(|path| path.clone())
            .unwrap_or_else(|poison| poison.into_inner().clone())
    }

    /// Activates a verified NOVA-managed media tool for subsequent operations.
    /// Existing child processes keep their original executable; newly created
    /// analyses and downloads use the replacement immediately.
    pub fn activate_external_tool(&self, tool_id: ToolId, path: String) -> Result<(), String> {
        match tool_id {
            ToolId::YtDlp => {
                let mut ytdlp = self
                    .ytdlp_bin
                    .write()
                    .map_err(|e| format!("yt-dlp path lock poisoned: {e}"))?;
                *ytdlp = path;
                drop(ytdlp);
                let replacement = std::sync::Arc::new(crate::daemon::ytdlp::YtDlpExtractor::new(
                    self.ytdlp_binary(),
                    self.ffmpeg_binary(),
                ));
                if !self
                    .extractor_registry
                    .replace("yt-dlp", replacement)
                    .map_err(|e| e.to_string())?
                {
                    return Err("yt-dlp extractor was not registered".to_owned());
                }
            }
            ToolId::Ffmpeg => {
                let mut ffmpeg = self
                    .ffmpeg_bin
                    .write()
                    .map_err(|e| format!("FFmpeg path lock poisoned: {e}"))?;
                *ffmpeg = path;
            }
        }
        if let Ok(mut cache) = self.engine_capabilities_cache.write() {
            *cache = None;
        }
        Ok(())
    }

    pub fn deactivate_external_tool(&self, tool_id: ToolId) -> Result<(), String> {
        match tool_id {
            ToolId::YtDlp => {
                let mut ytdlp = self
                    .ytdlp_bin
                    .write()
                    .map_err(|e| format!("yt-dlp path lock poisoned: {e}"))?;
                *ytdlp = self.bundled_ytdlp_bin.clone();
                drop(ytdlp);
                let replacement = std::sync::Arc::new(crate::daemon::ytdlp::YtDlpExtractor::new(
                    self.ytdlp_binary(),
                    self.ffmpeg_binary(),
                ));
                if !self
                    .extractor_registry
                    .replace("yt-dlp", replacement)
                    .map_err(|e| e.to_string())?
                {
                    return Err("yt-dlp extractor was not registered".to_owned());
                }
            }
            ToolId::Ffmpeg => {
                let mut ffmpeg = self
                    .ffmpeg_bin
                    .write()
                    .map_err(|e| format!("FFmpeg path lock poisoned: {e}"))?;
                *ffmpeg = self.bundled_ffmpeg_bin.clone();
            }
        }
        if let Ok(mut cache) = self.engine_capabilities_cache.write() {
            *cache = None;
        }
        Ok(())
    }

    pub fn engine_capabilities(&self) -> Arc<serde_json::Value> {
        // Fast path: serve a still-fresh cached value without taking the
        // probe mutex.
        if let Ok(cache) = self.engine_capabilities_cache.read() {
            if let Some((ref value, ref ts)) = *cache {
                if ts.elapsed().as_secs() < ENGINE_CACHE_TTL_SECS {
                    return value.clone();
                }
            }
        }
        // Serialize the read-check-probe-write sequence so concurrent callers
        // do not each spawn redundant subprocess probes (TOC/TOU race).
        let _guard = match self.engine_capabilities_probe.lock() {
            Ok(guard) => guard,
            Err(poison) => {
                log::warn!("engine_capabilities probe mutex poisoned, recovering");
                poison.into_inner()
            }
        };
        // Re-check under the probe lock — another request may have refreshed
        // the cache while we waited.
        if let Ok(cache) = self.engine_capabilities_cache.read() {
            if let Some((ref value, ref ts)) = *cache {
                if ts.elapsed().as_secs() < ENGINE_CACHE_TTL_SECS {
                    return value.clone();
                }
            }
        }
        let result = crate::daemon::engine_capabilities::all_engine_status(
            &self.ytdlp_binary(),
            &self.ffmpeg_binary(),
        );
        let arc_result = Arc::new(result);
        if let Ok(mut cache) = self.engine_capabilities_cache.write() {
            *cache = Some((arc_result.clone(), Instant::now()));
        }
        arc_result
    }
}

pub type SharedState = Arc<AppState>;
