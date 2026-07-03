use std::collections::HashMap;
use std::process::Child;
use std::sync::{Arc, Mutex};
use reqwest::Client as HttpClient;

use crate::daemon::types::{MediaJob, TelegramConfig, TorrentConfigBody};

pub struct AppState {
    pub aria2_process: Mutex<Option<Child>>,
    pub media_jobs: Mutex<HashMap<String, MediaJob>>,
    pub aria2_meta: Mutex<HashMap<String, HashMap<String, serde_json::Value>>>,
    pub torrent_config: Mutex<TorrentConfigBody>,
    pub telegram_config: Mutex<TelegramConfig>,
    pub http_client: HttpClient,
    pub resource_dir: String,
    pub aria2_rpc_port: u16,
    pub aria2_secret: String,
    pub aria2_bin: String,
    pub ytdlp_bin: String,
}

pub type SharedState = Arc<AppState>;
