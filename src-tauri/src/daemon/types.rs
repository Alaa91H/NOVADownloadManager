use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct TorrentMetadata {
    pub infoHash: String,
    pub mode: String,
    pub numPeers: u32,
    pub numSeeders: u32,
    pub uploadSpeed: u64,
    pub uploadLength: u64,
    pub seeder: bool,
    pub seedRatio: f64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(rename = "fileType")]
    pub file_type: String,
    pub status: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "speedBytesPerSec")]
    pub speed_bytes_per_sec: u64,
    #[serde(rename = "timeLeftSeconds")]
    pub time_left_seconds: u64,
    #[serde(rename = "dateAdded")]
    pub date_added: String,
    pub category: String,
    #[serde(rename = "queueId")]
    pub queue_id: String,
    pub connections: u32,
    pub resumable: bool,
    #[serde(rename = "savePath")]
    pub save_path: String,
    pub description: String,
    pub segments: Vec<Segment>,
    pub referer: Option<String>,
    pub engine: String,
    #[serde(rename = "engineId")]
    pub engine_id: String,
    #[serde(rename = "engineStatus")]
    pub engine_status: Option<String>,
    #[serde(rename = "errorMessage")]
    pub error_message: Option<String>,
    #[serde(rename = "torrentMetadata")]
    pub torrent_metadata: Option<TorrentMetadata>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: u32,
    pub progress: f64,
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: u64,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    pub active: bool,
    pub speed: u64,
}

#[derive(Clone, Default, Deserialize)]
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

#[derive(Deserialize)]
pub struct CreateDownloadBody {
    pub url: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "fileType")]
    pub file_type: Option<String>,
    #[serde(rename = "sizeBytes")]
    #[allow(dead_code)]
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
    #[allow(dead_code)]
    pub start_immediately: Option<bool>,
    #[serde(rename = "directOptions")]
    pub direct_options: Option<HashMap<String, serde_json::Value>>,
    #[serde(rename = "mediaOptions")]
    pub media_options: Option<MediaDownloadOptions>,
}

// Wire contract for the torrent endpoint. The fields are populated by serde on
// deserialization but not read further while torrent support is gated off, so
// dead-code analysis cannot see the use.
#[allow(dead_code)]
#[derive(Deserialize)]
pub struct TorrentBody {
    #[serde(rename = "torrentBase64")]
    pub torrent_base64: Option<String>,
    pub magnet: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
    #[serde(rename = "startImmediately")]
    pub start_immediately: Option<bool>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TorrentConfigBody {
    pub dht: Option<bool>,
    pub pex: Option<bool>,
    pub encryption: Option<bool>,
    #[serde(rename = "listenPort")]
    pub listen_port: Option<u16>,
    #[serde(rename = "maxPeers")]
    pub max_peers: Option<u32>,
    pub seeding: Option<bool>,
    #[serde(rename = "ratioLimit")]
    pub ratio_limit: Option<f64>,
    #[serde(rename = "uploadSpeed")]
    pub upload_speed: Option<u32>,
}

fn default_telegram_api_base() -> String {
    "https://api.telegram.org".to_string()
}

fn default_telegram_file_upload_limit_mb() -> u64 {
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
}

#[derive(Clone)]
pub struct CurlJob {
    pub task: Task,
    /// Legacy process id field kept for compatibility with older code paths.
    /// The direct engine now runs in-process through libcurl multi, so this is
    /// normally None.
    #[allow(dead_code)]
    pub child: Option<u32>,
    /// Legacy/debug curl CLI argument vector. The runtime direct engine does not
    /// execute this vector; it is retained for diagnostics and migration.
    pub args: Vec<String>,
    pub direct_options: HashMap<String, serde_json::Value>,
    pub cancel_token: Arc<AtomicBool>,
    /// Monotonic run id used to prevent stale libcurl worker threads from
    /// updating task state after pause/resume/delete races.
    pub run_generation: Arc<AtomicU64>,
}
