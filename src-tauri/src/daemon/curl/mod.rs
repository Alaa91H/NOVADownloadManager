mod args;
mod completion;
mod easy_config;
mod multi;
mod task_api;
mod transfer;
pub mod transfer_config;

pub use args::build_curl_args;
pub use easy_config::init_download_ssl;
pub use task_api::{
    create_curl_task, curl_version, delete_task, get_task, list_all_tasks, pause_task,
    redownload_task, resume_task, update_task_metadata, CurlExtractor,
};
pub use transfer::start_curl_process;

pub(crate) use args::proxy_resolves_to_internal;
pub(super) use args::{destination_from_body, requested_connections, safe_value};
pub(super) use easy_config::{apply_easy_options, create_easy_for_range_ext, HtmlHeadCapture};
pub(super) use multi::{drive_multi_wait_perform, drive_multi_wait_perform_until, CurlMultiGuard};
#[allow(unused_imports)]
pub(super) use transfer::{remove_stale_parts_for, split_ranges, task_from_body};
pub(super) use transfer_config::CurlTransferConfig;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

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
    /// When `true`, the RIE (Resource Intelligence Engine) has already
    /// resolved the final URL, determined range support, and completed the
    /// full preflight analysis using reqwest with anti-bot headers
    /// (Sec-Fetch-*, realistic User-Agent, Cloudflare bypass). The curl
    /// download thread should skip its own `resolve_effective_target`
    /// preflight and trust the RIE's results to avoid:
    /// - Redundant HTTP requests that double latency
    /// - Different TLS fingerprints between reqwest and libcurl triggering
    ///   bot detection
    /// - Loss of cookie/session state from the RIE probe
    /// - Cloudflare challenge pages being returned on the second request
    pub(super) preflight_resolved: bool,
    /// Range support detected by the RIE preflight. Only meaningful when
    /// `preflight_resolved` is `true`.
    pub(super) preflight_supports_range: bool,
}

impl DirectDownloadPlan {
    /// Clone with a different `url` — the only field that changes across
    /// preflight redirect/meta-refresh hops (M10). Avoids cloning the whole
    /// plan (config, mirrors, validator) for every hop.
    pub(super) fn clone_with_url(&self, url: String) -> Self {
        let mut plan = self.clone();
        plan.url = url;
        plan
    }
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
    /// HTTP version from the first response status line (e.g., "1.1", "2").
    /// Captured by the header callback and read back by the adaptive engine.
    pub(super) http_version: Option<String>,
    /// Total body size discovered from the response `Content-Length` header,
    /// or the `*/total` part of a `Content-Range` header. Lets the UI show a
    /// live progress percentage even when the download started with an
    /// unknown size (`size_bytes == 0`).
    pub(super) content_length: Option<u64>,
}

pub(super) struct SegmentProgress {
    pub(super) downloaded: Arc<AtomicU64>,
    pub(super) abort: Arc<AtomicBool>,
    pub(super) retry_after: Arc<AtomicU64>,
    pub(super) capture: Arc<Mutex<ResponseCapture>>,
    pub(super) streaming_digest_out: Arc<Mutex<Option<String>>>,
    /// Set by the header callback when the server answers 200 (instead of the
    /// requested 206) to a partial-range request. Shared across all segments
    /// so every write callback stops immediately (C-2).
    pub(super) range_rejected: Arc<AtomicBool>,
    /// Set by the header callback when a range response carries a real
    /// `Content-Encoding` (gzip/br/deflate). libcurl decompresses each
    /// segment independently, so the decompressed bytes no longer align with
    /// the requested file offsets and the merged output would be silently
    /// corrupted. Shared across all segments so every write callback stops
    /// immediately and the attempt falls back to a single connection (which
    /// handles Content-Encoding correctly).
    pub(super) encoding_rejected: Arc<AtomicBool>,
    /// True when this segment requested a partial range and therefore must
    /// receive a 206 response for the transfer to be valid.
    pub(super) expects_206: bool,
}
