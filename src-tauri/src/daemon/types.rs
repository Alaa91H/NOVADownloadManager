use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    pub bitrate: Option<String>,
    #[serde(rename = "outputTemplate")]
    pub output_template: Option<String>,
    pub playlist: Option<bool>,
    #[serde(rename = "playlistItems")]
    pub playlist_items: Option<String>,
    pub subtitles: Option<bool>,
    #[serde(rename = "subtitleLanguages")]
    pub subtitle_languages: Option<String>,
    pub proxy: Option<String>,
    pub cookies: Option<String>,
    #[serde(rename = "userAgent")]
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    #[serde(rename = "rateLimitKbs")]
    pub rate_limit_kbs: Option<u64>,
    pub retries: Option<u64>,
    #[serde(rename = "concurrentFragments")]
    pub concurrent_fragments: Option<u64>,
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

#[derive(Deserialize)]
pub struct TorrentBody {
    #[serde(rename = "torrentBase64")]
    pub torrent_base64: Option<String>,
    pub magnet: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "savePath")]
    pub save_path: Option<String>,
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

#[derive(Clone, Default, Deserialize, Serialize)]
pub struct TelegramConfig {
    pub enabled: bool,
    pub token: String,
    pub chat_id: i64,
}

#[derive(Clone)]
pub struct MediaJob {
    pub task: Task,
    pub child: Option<u32>,
    pub args: Vec<String>,
}
