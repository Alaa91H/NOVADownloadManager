mod args;
mod easy_config;
mod multi;
mod task_api;
mod transfer;
pub(crate) mod transfer_config;

pub(crate) use args::build_curl_args;
pub(crate) use easy_config::init_download_ssl;
pub(crate) use task_api::{
    create_curl_task, curl_version, delete_task, list_all_tasks, pause_task, redownload_task,
    resume_task, update_task_metadata, CurlExtractor,
};
pub(crate) use transfer::start_curl_process;

pub(super) use args::{destination_from_body, requested_connections, safe_value};
pub(super) use easy_config::{apply_easy_options, create_easy_for_range_ext, HtmlHeadCapture};
pub(super) use multi::{drive_multi_socket, drive_multi_wait_perform, CurlMultiGuard};
#[allow(unused_imports)]
pub(super) use transfer::{remove_stale_parts_for, split_ranges, task_from_body};
pub(super) use transfer_config::CurlTransferConfig;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

pub(super) const DEFAULT_DIRECT_CONNECTIONS: u32 = 8;
pub(super) const MAX_DIRECT_CONNECTIONS: u32 = 32;
pub(super) const MIN_SEGMENT_SIZE: u64 = 1024 * 1024;
pub(super) const PROGRESS_INTERVAL_MS: u64 = 250;

#[derive(Clone, Debug)]
pub(super) struct DirectDownloadPlan {
    pub(super) url: String,
    pub(super) output_path: PathBuf,
    pub(super) total_size: u64,
    pub(super) connections: u32,
    pub(super) resumable: bool,
    pub(super) allow_overwrite: bool,
    pub(super) follow_redirects: bool,
    pub(super) fail_on_error: bool,
    pub(super) segmented: bool,
    pub(super) remove_on_error: bool,
    pub(super) referer: Option<String>,
    pub(super) config: CurlTransferConfig,
    pub(super) validator: Option<String>,
    pub(super) validator_is_etag: bool,
    pub(super) digest_sha256: Option<String>,
    pub(super) link_mirrors: Vec<String>,
    pub(super) mirror_priorities: Vec<u32>,
}

#[derive(Default, Clone)]
pub(super) struct ResponseCapture {
    pub(super) status_code: u16,
    pub(super) validator: Option<String>,
    pub(super) digest_sha256: Option<String>,
    pub(super) mirrors: Vec<String>,
    /// True when the server actually responded with a `Content-Encoding`
    /// other than `identity`. Only then is the on-disk size allowed to
    /// differ from the probed Content-Length, because libcurl transparently
    /// decompresses the body.
    pub(super) content_encoded: bool,
}

pub(super) struct SegmentProgress {
    pub(super) downloaded: Arc<AtomicU64>,
    pub(super) abort: Arc<AtomicBool>,
    pub(super) retry_after: Arc<AtomicU64>,
    pub(super) capture: Arc<Mutex<ResponseCapture>>,
    pub(super) streaming_digest_out: Arc<Mutex<Option<String>>>,
}
