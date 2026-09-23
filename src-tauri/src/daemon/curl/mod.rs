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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ContentRange {
    pub(super) start: u64,
    pub(super) end: u64,
    pub(super) total: Option<u64>,
}

fn normalize_sha256_fingerprint(raw: &str) -> Option<String> {
    if let Some(parsed) = crate::daemon::utils::parse_sha256_digest(raw) {
        return Some(parsed);
    }

    let value = raw.trim().trim_matches(':');
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Some(value.to_ascii_lowercase());
    }

    let decoded = crate::daemon::utils::base64_decode(value)?;
    (decoded.len() == 32).then(|| {
        decoded
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct RemoteFingerprint {
    pub(super) validator: Option<String>,
    pub(super) validator_is_etag: bool,
    pub(super) total_size: Option<u64>,
    pub(super) digest_sha256: Option<String>,
}

impl RemoteFingerprint {
    /// Return true only for concrete contradictions. Missing fields do not
    /// conflict: many servers omit ETag/Digest on 206 responses even though
    /// If-Range semantics still bind the response to the requested object.
    pub(super) fn conflicts_with(&self, observed: &Self) -> bool {
        if let (Some(expected), Some(actual)) = (&self.validator, &observed.validator) {
            // ETag and Last-Modified are different validator namespaces. A
            // server may start/stop exposing one of them without changing the
            // representation, so only compare values when both fingerprints
            // refer to the SAME validator kind.
            if self.validator_is_etag == observed.validator_is_etag
                && expected.trim() != actual.trim()
            {
                return true;
            }
        }
        if let (Some(expected), Some(actual)) = (self.total_size, observed.total_size) {
            if expected != actual {
                return true;
            }
        }
        if let (Some(expected), Some(actual)) = (&self.digest_sha256, &observed.digest_sha256) {
            if !expected.trim().eq_ignore_ascii_case(actual.trim()) {
                return true;
            }
        }
        false
    }

    /// Merge newly observed identity fields into this fingerprint while
    /// refusing concrete contradictions. This lets parallel segments share a
    /// gradually learned identity even when the preflight did not expose an
    /// ETag or digest.
    pub(super) fn absorb_consistent(&mut self, observed: &Self) -> bool {
        if self.conflicts_with(observed) {
            return false;
        }

        if self.validator.is_none() {
            if let Some(validator) = observed.validator.as_ref() {
                self.validator = Some(validator.clone());
                self.validator_is_etag = observed.validator_is_etag;
            }
        }
        if self.total_size.is_none() {
            self.total_size = observed.total_size;
        }
        if self.digest_sha256.is_none() {
            self.digest_sha256 = observed.digest_sha256.clone();
        }
        true
    }
}

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

    pub(super) fn remote_fingerprint(&self) -> RemoteFingerprint {
        RemoteFingerprint {
            validator: self.validator.clone(),
            validator_is_etag: self.validator_is_etag,
            total_size: (self.total_size > 0).then_some(self.total_size),
            digest_sha256: self
                .representation_digest_sha256
                .as_deref()
                .and_then(normalize_sha256_fingerprint),
        }
    }
}

#[derive(Default, Clone)]
pub(super) struct ResponseCapture {
    pub(super) status_code: u16,
    pub(super) validator: Option<String>,
    pub(super) validator_is_etag: bool,
    /// Digest advertised for the response content. On a 206 this may describe
    /// only the selected range and therefore is NOT a whole-file fingerprint.
    pub(super) digest_sha256: Option<String>,
    /// Repr-Digest identifies the complete selected representation and is safe
    /// to compare across sibling byte-range responses.
    pub(super) representation_digest_sha256: Option<String>,
    pub(super) mirrors: Vec<String>,
    /// Parsed Content-Range from the final HTTP response.
    pub(super) content_range: Option<ContentRange>,
    /// Start offset requested by this handle. This is kept separately so a
    /// single-connection resume can still validate its start when the remote
    /// total size was previously unknown.
    pub(super) expected_range_start: Option<u64>,
    /// Exact range requested by this handle when the end/total are known.
    /// Body bytes are not accepted until final 206 headers prove it matches.
    pub(super) expected_content_range: Option<ContentRange>,
    /// Remote identity known before this request (validator/size/digest).
    /// Concrete contradictions reject the response before any body is written.
    pub(super) expected_fingerprint: Option<RemoteFingerprint>,
    /// Shared identity learned across sibling segment responses. A segment may
    /// be the first request that exposes an ETag or Content-Digest; later
    /// segments must agree before their bytes can be accepted.
    pub(super) shared_fingerprint: Option<Arc<Mutex<RemoteFingerprint>>>,
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

impl ResponseCapture {
    pub(super) fn observed_fingerprint(&self) -> RemoteFingerprint {
        RemoteFingerprint {
            validator: self.validator.clone(),
            validator_is_etag: self.validator_is_etag,
            total_size: self
                .content_range
                .and_then(|range| range.total)
                .or(self.content_length),
            digest_sha256: self
                .representation_digest_sha256
                .as_deref()
                .and_then(normalize_sha256_fingerprint),
        }
    }
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

#[cfg(test)]
mod fingerprint_tests {
    use super::{normalize_sha256_fingerprint, RemoteFingerprint};

    #[test]
    fn sha256_fingerprint_normalizes_hex_and_structured_digest_forms() {
        let hex = "a".repeat(64);
        assert_eq!(normalize_sha256_fingerprint(&hex), Some(hex.clone()));
        assert_eq!(
            normalize_sha256_fingerprint(&format!("SHA-256={hex}")),
            Some(hex)
        );

        let zero_b64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        assert_eq!(
            normalize_sha256_fingerprint(&format!("sha-256=:{zero_b64}:")),
            Some("0".repeat(64))
        );
    }

    #[test]
    fn remote_fingerprint_only_rejects_concrete_contradictions() {
        let expected = RemoteFingerprint {
            validator: Some("\"v1\"".to_owned()),
            validator_is_etag: true,
            total_size: Some(1024),
            digest_sha256: Some("a".repeat(64)),
        };

        assert!(!expected.conflicts_with(&RemoteFingerprint::default()));
        assert!(expected.conflicts_with(&RemoteFingerprint {
            validator: Some("\"v2\"".to_owned()),
            validator_is_etag: true,
            ..Default::default()
        }));
        assert!(!expected.conflicts_with(&RemoteFingerprint {
            validator: Some("Wed, 23 Sep 2026 20:00:00 GMT".to_owned()),
            validator_is_etag: false,
            ..Default::default()
        }));
        assert!(expected.conflicts_with(&RemoteFingerprint {
            total_size: Some(2048),
            ..Default::default()
        }));

    #[test]
    fn shared_fingerprint_learns_missing_fields_then_rejects_drift() {
        let mut shared = RemoteFingerprint {
            total_size: Some(1000),
            ..Default::default()
        };
        assert!(shared.absorb_consistent(&RemoteFingerprint {
            validator: Some("\"v1\"".to_owned()),
            validator_is_etag: true,
            total_size: Some(1000),
            ..Default::default()
        }));
        assert_eq!(shared.validator.as_deref(), Some("\"v1\""));

        assert!(!shared.absorb_consistent(&RemoteFingerprint {
            validator: Some("\"v2\"".to_owned()),
            validator_is_etag: true,
            total_size: Some(1000),
            ..Default::default()
        }));
    }
    }
}
