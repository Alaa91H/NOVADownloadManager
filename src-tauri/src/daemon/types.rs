pub use nova_core_model::{Segment, Task, TaskState};

/// Apply a normal task lifecycle transition using the shared NOVA state
/// machine while preserving the existing string-based wire schema.
pub fn transition_task_state(
    task: &mut Task,
    next: TaskState,
    engine_status: impl Into<String>,
) -> Result<(), String> {
    let current = TaskState::from_status(&task.status).ok_or_else(|| {
        format!(
            "Task {} has unknown lifecycle state '{}'",
            task.id, task.status
        )
    })?;
    if !current.can_transition_to(next) {
        return Err(format!(
            "Illegal task state transition for {}: {} -> {}",
            task.id,
            current.as_status(),
            next.as_status()
        ));
    }
    task.status = next.as_status().to_owned();
    task.engine_status = Some(engine_status.into());
    Ok(())
}

/// Apply an explicit restart/redownload transition. Completed tasks can only
/// leave their terminal state through this API, never via ordinary lifecycle
/// progression.
pub fn restart_task_state(task: &mut Task, engine_status: impl Into<String>) -> Result<(), String> {
    let current = TaskState::from_status(&task.status).ok_or_else(|| {
        format!(
            "Task {} has unknown lifecycle state '{}'",
            task.id, task.status
        )
    })?;
    if !current.can_restart_to(TaskState::Queued) {
        return Err(format!(
            "Task {} cannot be restarted from state {}",
            task.id,
            current.as_status()
        ));
    }
    task.status = TaskState::Queued.as_status().to_owned();
    task.engine_status = Some(engine_status.into());
    Ok(())
}

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct MediaDownloadOptions {
    pub mode: Option<String>,
    pub quality: Option<String>,
    #[serde(rename = "formatSelector")]
    pub format_selector: Option<String>,
    #[serde(rename = "formatSort")]
    pub format_sort: Option<String>,
    #[serde(rename = "audioFormat")]
    pub audio_format: Option<String>,
    #[serde(rename = "ffmpegEnabled")]
    pub ffmpeg_enabled: Option<bool>,
    #[serde(rename = "ffmpegLocation")]
    pub ffmpeg_location: Option<String>,
    pub bitrate: Option<String>,
    #[serde(rename = "outputTemplate")]
    pub output_template: Option<String>,
    pub playlist: Option<bool>,
    #[serde(rename = "playlistItems")]
    pub playlist_items: Option<String>,
    pub subtitles: Option<bool>,
    #[serde(rename = "subtitleLanguages")]
    pub subtitle_languages: Option<String>,
    #[serde(rename = "autoSubtitles")]
    pub auto_subtitles: Option<bool>,
    #[serde(rename = "embedSubtitles")]
    pub embed_subtitles: Option<bool>,
    #[serde(rename = "writeThumbnail")]
    pub write_thumbnail: Option<bool>,
    #[serde(rename = "embedThumbnail")]
    pub embed_thumbnail: Option<bool>,
    #[serde(rename = "writeInfoJson")]
    pub write_info_json: Option<bool>,
    #[serde(rename = "writeDescription")]
    pub write_description: Option<bool>,
    #[serde(rename = "splitChapters")]
    pub split_chapters: Option<bool>,
    #[serde(rename = "sponsorBlock")]
    pub sponsor_block: Option<String>,
    pub proxy: Option<String>,
    #[serde(rename = "sourceAddress")]
    pub source_address: Option<String>,
    pub cookies: Option<String>,
    #[serde(rename = "cookiesFromBrowser")]
    pub cookies_from_browser: Option<String>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub headers: Option<String>,
    #[serde(rename = "rateLimitKbs")]
    pub rate_limit_kbs: Option<u64>,
    pub retries: Option<u64>,
    #[serde(rename = "fragmentRetries")]
    pub fragment_retries: Option<u64>,
    #[serde(rename = "concurrentFragments")]
    pub concurrent_fragments: Option<u64>,

    #[serde(rename = "fileAccessRetries")]
    pub file_access_retries: Option<u64>,
    #[serde(rename = "retrySleep")]
    pub retry_sleep: Option<String>,
    #[serde(rename = "throttledRateKbs")]
    pub throttled_rate_kbs: Option<u64>,
    #[serde(rename = "bufferSizeKbs")]
    pub buffer_size_kbs: Option<u64>,
    #[serde(rename = "httpChunkSize")]
    pub http_chunk_size: Option<String>,
    #[serde(rename = "externalDownloader")]
    pub external_downloader: Option<String>,
    #[serde(rename = "externalDownloaderArgs")]
    pub external_downloader_args: Option<String>,
    #[serde(rename = "downloadArchive")]
    pub download_archive: Option<String>,
    #[serde(rename = "breakOnExisting")]
    pub break_on_existing: Option<bool>,
    #[serde(rename = "forceOverwrites")]
    pub force_overwrites: Option<bool>,
    #[serde(rename = "noOverwrites")]
    pub no_overwrites: Option<bool>,
    #[serde(rename = "restrictFilenames")]
    pub restrict_filenames: Option<bool>,
    #[serde(rename = "windowsFilenames")]
    pub windows_filenames: Option<bool>,
    #[serde(rename = "trimFilenames")]
    pub trim_filenames: Option<u64>,
    #[serde(rename = "writeComments")]
    pub write_comments: Option<bool>,
    #[serde(rename = "embedMetadata")]
    pub embed_metadata: Option<bool>,
    #[serde(rename = "embedChapters")]
    pub embed_chapters: Option<bool>,
    #[serde(rename = "convertThumbnails")]
    pub convert_thumbnails: Option<String>,
    #[serde(rename = "postprocessorArgs")]
    pub postprocessor_args: Option<String>,
    #[serde(rename = "extractorArgs")]
    pub extractor_args: Option<String>,
    #[serde(rename = "compatOptions")]
    pub compat_options: Option<String>,
    #[serde(rename = "liveFromStart")]
    pub live_from_start: Option<bool>,
    #[serde(rename = "waitForVideo")]
    pub wait_for_video: Option<String>,
    #[serde(rename = "sleepRequestsSec")]
    pub sleep_requests_sec: Option<u64>,
    #[serde(rename = "sleepSubtitlesSec")]
    pub sleep_subtitles_sec: Option<u64>,
    #[serde(rename = "socketTimeoutSec")]
    pub socket_timeout_sec: Option<u64>,
    #[serde(rename = "minFilesize")]
    pub min_filesize: Option<String>,
    #[serde(rename = "maxFilesize")]
    pub max_filesize: Option<String>,
    #[serde(rename = "maxDownloads")]
    pub max_downloads: Option<u64>,
    pub username: Option<String>,
    pub password: Option<String>,
    #[serde(rename = "twoFactor")]
    pub two_factor: Option<String>,
    pub netrc: Option<bool>,
    #[serde(rename = "geoBypassCountry")]
    pub geo_bypass_country: Option<String>,
    #[serde(rename = "sleepIntervalSec")]
    pub sleep_interval_sec: Option<u64>,
    #[serde(rename = "maxSleepIntervalSec")]
    pub max_sleep_interval_sec: Option<u64>,
    #[serde(rename = "downloadSections")]
    pub download_sections: Option<String>,
    #[serde(rename = "matchFilter")]
    pub match_filter: Option<String>,
    #[serde(rename = "remuxFormat")]
    pub remux_format: Option<String>,
    #[serde(rename = "extraArgs")]
    pub extra_args: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct CreateDownloadBody {
    pub url: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "fileType")]
    pub file_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    pub category: Option<String>,
    #[serde(rename = "queueId")]
    pub queue_id: Option<String>,
    pub connections: Option<u32>,
    pub resumable: Option<bool>,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    pub description: Option<String>,
    pub referer: Option<String>,
    #[serde(rename = "startImmediately")]
    pub start_immediately: Option<bool>,
    #[serde(rename = "directOptions")]
    pub direct_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "mediaOptions")]
    pub media_options: Option<MediaDownloadOptions>,
}

fn default_telegram_api_base() -> String {
    "https://api.telegram.org".to_owned()
}

const fn default_telegram_file_upload_limit_mb() -> u64 {
    50
}

#[derive(Clone, Deserialize, Serialize)]
pub struct TelegramConfig {
    pub enabled: bool,
    pub token: String,
    pub chat_id: i64,
    #[serde(default = "default_telegram_api_base")]
    pub api_base: String,
    #[serde(default = "default_telegram_file_upload_limit_mb")]
    pub file_upload_limit_mb: u64,
}

impl Default for TelegramConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            token: String::new(),
            chat_id: 0,
            api_base: default_telegram_api_base(),
            file_upload_limit_mb: default_telegram_file_upload_limit_mb(),
        }
    }
}

#[derive(Clone)]
pub struct MediaJob {
    pub task: Task,
    pub child: Option<u32>,
    pub args: Vec<String>,
    pub start_time: Instant,
}

#[derive(Clone)]
pub struct CurlJob {
    pub task: Task,
    pub direct_options: HashMap<String, serde_json::Value>,
    pub cancel_token: Arc<AtomicBool>,
    /// Monotonic run id used to prevent stale libcurl worker threads from
    /// updating task state after pause/resume/delete races.
    pub run_generation: Arc<AtomicU64>,
    pub start_time: Instant,
    /// Previous per-segment downloaded bytes, used to compute segment speed.
    pub segment_prev_bytes: Vec<u64>,
    /// Curl command-line arguments for this job, persisted across restarts.
    pub args: Vec<String>,
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{restart_task_state, transition_task_state, Task, TaskState};

    fn task(status: &str) -> Task {
        Task {
            id: "state-test".to_owned(),
            name: "file.bin".to_owned(),
            url: "https://example.test/file.bin".to_owned(),
            file_type: "other".to_owned(),
            status: status.to_owned(),
            size_bytes: 10,
            downloaded_bytes: 0,
            speed_bytes_per_sec: 0,
            time_left_seconds: 0,
            elapsed_seconds: 0,
            date_added: "2026-09-24T00:00:00Z".to_owned(),
            category: "other".to_owned(),
            queue_id: "main".to_owned(),
            connections: 1,
            resumable: true,
            save_path: "file.bin".to_owned(),
            description: String::new(),
            segments: Vec::new(),
            referer: None,
            engine: "libcurl-multi".to_owned(),
            engine_id: "state-test".to_owned(),
            engine_status: None,
            error_message: None,
        }
    }

    #[test]
    fn daemon_transition_helper_rejects_direct_completion() {
        let mut task = task("downloading");
        let error = transition_task_state(&mut task, TaskState::Completed, "completed")
            .expect_err("direct completion must be rejected");
        assert!(error.contains("downloading -> completed"));
        assert_eq!(task.status, "downloading");
    }

    #[test]
    fn daemon_transition_helper_applies_completion_pipeline() {
        let mut task = task("downloading");
        transition_task_state(&mut task, TaskState::Verifying, "verifying-output").unwrap();
        transition_task_state(&mut task, TaskState::Finalizing, "finalizing-output").unwrap();
        transition_task_state(&mut task, TaskState::Completed, "completed").unwrap();
        assert_eq!(task.status, "completed");
        assert_eq!(task.engine_status.as_deref(), Some("completed"));
    }

    #[test]
    fn completed_task_requires_explicit_restart_helper() {
        let mut task = task("completed");
        assert!(transition_task_state(&mut task, TaskState::Queued, "queued").is_err());
        restart_task_state(&mut task, "redownload-requested").unwrap();
        assert_eq!(task.status, "queued");
        assert_eq!(task.engine_status.as_deref(), Some("redownload-requested"));
    }
}
