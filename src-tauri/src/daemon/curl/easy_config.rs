use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::os::raw::c_long;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::OnceLock;
use std::time::Duration;

use ::curl::easy::{
    Auth, Easy2, Form, Handler, HttpVersion, IpResolve, List, NetRc, ProxyType, SslOpt, SslVersion,
    TimeCondition, WriteError,
};

use super::{
    proxy_resolves_to_internal, safe_value, CurlTransferConfig, DirectDownloadPlan, SegmentProgress,
};
use crate::daemon::direct::FileWriter;
use crate::daemon::engine::config::global_config;
use crate::daemon::utils::DEFAULT_USER_AGENT;
use sha2::Digest;

// Raw FFI constants for curl options not wrapped by the curl crate.
// CURLOPTTYPE_OBJECTPOINT == CURLOPTTYPE_STRINGPOINT == 10_000
const CURLOPT_PRE_PROXY: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 262;
const CURLOPT_NETRC_FILE: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 118;
const CURLOPT_TLS13_CIPHERS: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 276;
const CURLOPT_FTP_CREATE_MISSING_DIRS: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_LONG + 110;
const CURLOPT_PROTOCOLS_STR: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 318;
const CURLOPT_REDIR_PROTOCOLS_STR: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 319;
const CURLOPT_DNS_INTERFACE: curl_sys::CURLoption = curl_sys::CURLOPTTYPE_OBJECTPOINT + 221;

unsafe fn raw_setopt_str(
    easy_ptr: *mut curl_sys::CURL,
    option: curl_sys::CURLoption,
    value: &str,
) -> Result<(), String> {
    let c_val = std::ffi::CString::new(value)
        .map_err(|e| format!("Could not convert option to CString: {e}"))?;
    // C-5: libcurl always strdups STRINGPOINT options, so the CString can be
    // dropped right after setopt. The previous `into_raw()` leaked one
    // allocation per option for the lifetime of the process.
    let code = unsafe { curl_sys::curl_easy_setopt(easy_ptr, option, c_val.as_ptr()) };
    if code == curl_sys::CURLE_OK {
        Ok(())
    } else {
        Err(format!("libcurl rejected option (code {code})"))
    }
}

unsafe fn raw_setopt_long(
    easy_ptr: *mut curl_sys::CURL,
    option: curl_sys::CURLoption,
    value: c_long,
) -> Result<(), String> {
    let code = unsafe { curl_sys::curl_easy_setopt(easy_ptr, option, value) };
    if code == curl_sys::CURLE_OK {
        Ok(())
    } else {
        Err(format!("libcurl rejected option (code {code})"))
    }
}

fn configured_speed_limit_bytes(config: &CurlTransferConfig) -> Option<u64> {
    config.u64_("speedLimitBytes").or_else(|| {
        config
            .u64_("speedLimitKbs")
            .map(|value| value.saturating_mul(1024))
    })
}

fn parse_rate_to_bytes(rate_str: &str) -> Option<u64> {
    let trimmed = rate_str.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (num_str, multiplier) = if let Some(s) = trimmed.strip_suffix(['T', 't']) {
        (s, 1024u64.pow(4))
    } else if let Some(s) = trimmed.strip_suffix(['G', 'g']) {
        (s, 1024u64.pow(3))
    } else if let Some(s) = trimmed.strip_suffix(['M', 'm']) {
        (s, 1024u64.pow(2))
    } else if let Some(s) = trimmed.strip_suffix(['K', 'k']) {
        (s, 1024)
    } else {
        (trimmed, 1)
    };
    let num_str = num_str.trim();
    // Use integer math, not f64, so very large rates stay exact (f64 loses
    // precision above ~2^53 bytes/s, i.e. >9 PB/s). An optional fractional
    // part ("1.5M") is handled by scaling everything by 10^frac_digits,
    // multiplying, then dividing back; truncation matches the old f64 cast.
    let (whole, frac) = match num_str.split_once('.') {
        Some((w, f)) => (w, f),
        None => (num_str, ""),
    };
    if whole.is_empty() || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let scale = 10u64.checked_pow(frac.len() as u32)?;
    let scaled = whole
        .parse::<u64>()
        .ok()?
        .checked_mul(scale)?
        .checked_add(frac.parse::<u64>().ok()?)?;
    scaled.checked_mul(multiplier)?.checked_div(scale)
}

pub struct SegmentWriter {
    pub(super) file: File,
    pub(super) progress: SegmentProgress,
    pub(super) streaming_hasher: Option<sha2::Sha256>,
}

impl Handler for SegmentWriter {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.progress.abort.load(Ordering::Relaxed)
            || self.progress.range_rejected.load(Ordering::Relaxed)
            || self.progress.encoding_rejected.load(Ordering::Relaxed)
        {
            return Ok(0);
        }
        if let Some(ref mut hasher) = self.streaming_hasher {
            sha2::Digest::update(hasher, data);
        }
        match self.file.write_all(data) {
            Ok(()) => {
                self.progress
                    .downloaded
                    .fetch_add(data.len() as u64, Ordering::Release);
                Ok(data.len())
            }
            Err(e) => {
                log::warn!("SegmentWriter write error: {e}");
                self.progress.abort.store(true, Ordering::Relaxed);
                Err(WriteError::Pause)
            }
        }
    }

    fn progress(&mut self, _dltotal: f64, _dlnow: f64, _ultotal: f64, _ulnow: f64) -> bool {
        !self.progress.abort.load(Ordering::Relaxed)
            && !self.progress.range_rejected.load(Ordering::Relaxed)
            && !self.progress.encoding_rejected.load(Ordering::Relaxed)
    }

    fn header(&mut self, data: &[u8]) -> bool {
        let Ok(line) = std::str::from_utf8(data) else {
            return true;
        };
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("HTTP/") {
            let mut parts = rest.split_whitespace();
            // The first token is the HTTP version (e.g., "1.1", "2").
            if let Some(ver) = parts.next() {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.http_version = Some(ver.to_owned());
                }
            }
            // The second token is the status code.
            if let Some(code) = parts.next().and_then(|c| c.parse().ok()) {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.status_code = code;
                }
                // C-2: a segment that requested a partial range must receive
                // 206. A 200 means the server ignored the Range header and is
                // sending the whole body to every segment. Flag it so ALL
                // segments stop writing immediately (shared flag) instead of
                // downloading the file N times in parallel before failing at
                // merge time.
                if code == 200 && self.progress.expects_206 {
                    self.progress.range_rejected.store(true, Ordering::Release);
                }
            }
            return true;
        }
        let Some((name, value)) = line.split_once(':') else {
            return true;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "retry-after" => {
                if let Ok(secs) = value.parse::<u64>() {
                    self.progress
                        .retry_after
                        .store(secs.min(600), Ordering::Relaxed);
                } else if let Some(secs) = crate::daemon::utils::parse_retry_after_date(value) {
                    self.progress
                        .retry_after
                        .store(secs.min(600), Ordering::Relaxed);
                }
            }
            "etag" if crate::daemon::utils::is_strong_etag(value) => {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.validator = Some(value.to_owned());
                }
            }
            "content-encoding" if !value.eq_ignore_ascii_case("identity") => {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    cap.content_encoded = true;
                }
                // C-5: a byte-range response with a real Content-Encoding is
                // unsafe for segmented downloads — each segment receives an
                // independently compressed stream whose decompressed bytes no
                // longer align with the requested file offsets, so merging the
                // parts would silently corrupt the output. Flag it so ALL
                // segments stop writing and the attempt falls back to a single
                // connection (which handles Content-Encoding correctly).
                if self.progress.expects_206 {
                    self.progress
                        .encoding_rejected
                        .store(true, Ordering::Release);
                }
            }
            "content-length" => {
                if let Ok(size) = value.parse::<u64>() {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        if cap.content_length.is_none() {
                            cap.content_length = Some(size);
                        }
                    }
                }
            }
            "content-range" => {
                // e.g. "bytes 0-1023/2048" or "bytes */2048"; the total after
                // the slash is the true object size. On a 206 partial response
                // the Content-Length only describes the current chunk, so the
                // Content-Range total must take precedence whenever present.
                if let Some(total) = value
                    .rsplit('/')
                    .next()
                    .and_then(|t| t.trim().parse::<u64>().ok())
                {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.content_length = Some(total);
                    }
                }
            }
            "last-modified" => {
                if let Ok(mut cap) = self.progress.capture.lock() {
                    if cap.validator.is_none() {
                        cap.validator = Some(value.to_owned());
                    }
                }
            }
            "repr-digest" | "content-digest" | "digest" => {
                if let Some(d) = crate::daemon::utils::parse_sha256_digest(value) {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.digest_sha256 = Some(d);
                    }
                    if self.streaming_hasher.is_none() {
                        self.streaming_hasher = Some(sha2::Sha256::new());
                    }
                }
            }
            "link" => {
                if let Some(url) = crate::daemon::utils::parse_link_duplicate_single(value) {
                    if let Ok(mut cap) = self.progress.capture.lock() {
                        cap.mirrors.push(url);
                    }
                }
            }
            _ => {}
        }
        true
    }
}

impl Drop for SegmentWriter {
    fn drop(&mut self) {
        if let Some(hasher) = self.streaming_hasher.take() {
            let hex = format!("{:x}", hasher.finalize());
            match self.progress.streaming_digest_out.lock() {
                Ok(mut slot) => *slot = Some(hex),
                Err(e) => log::warn!("SegmentWriter: streaming_digest_out lock poisoned: {e}"),
            }
        }
    }
}

const HTML_HEAD_CAPTURE_LIMIT: usize = 64 * 1024;
#[derive(Default)]
pub struct HtmlHeadCapture {
    body: Vec<u8>,
    http_version: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    /// The real object size learned from `Content-Length` (200 responses) or
    /// the `Content-Range` total (206 partial responses). The preflight uses
    /// this to seed `plan.total_size` before the transfer starts, so the UI
    /// can show a true progress percentage from byte one instead of a fake
    /// 0% that jumps to 100% at completion.
    content_length: Option<u64>,
    /// Strong remote identity captured before any resumable/ranged body is
    /// committed. Strong ETag wins; Last-Modified is the standards-compatible
    /// fallback for If-Range when no strong ETag is available.
    validator: Option<String>,
    validator_is_etag: bool,
}
impl Handler for HtmlHeadCapture {
    fn write(&mut self, data: &[u8]) -> Result<usize, WriteError> {
        if self.body.len() < HTML_HEAD_CAPTURE_LIMIT {
            let remaining = HTML_HEAD_CAPTURE_LIMIT - self.body.len();
            self.body
                .extend_from_slice(&data[..data.len().min(remaining)]);
        }
        Ok(data.len())
    }
    fn header(&mut self, data: &[u8]) -> bool {
        let Ok(line) = std::str::from_utf8(data) else {
            return true;
        };
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("HTTP/") {
            if let Some(ver) = rest.split_whitespace().next() {
                if let Ok(mut v) = self.http_version.lock() {
                    *v = Some(ver.to_owned());
                }
            }
            // A single libcurl request may contain headers from multiple HTTP
            // responses (redirects, proxy CONNECT, auth retries). Never carry
            // object identity or size from an earlier response into the final
            // effective resource.
            self.content_length = None;
            self.validator = None;
            self.validator_is_etag = false;
            return true;
        }
        // Header lines: capture the true object size so a range probe that
        // received `bytes=0-0` still reports the FULL file size. Mirrors the
        // SegmentWriter parsing (Content-Range total takes precedence on 206).
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim();
            match name.as_str() {
                "content-length" => {
                    if let Ok(size) = value.parse::<u64>() {
                        if self.content_length.is_none() {
                            self.content_length = Some(size);
                        }
                    }
                }
                "content-range" => {
                    // e.g. "bytes 0-1023/2048" or "bytes */2048"; the total
                    // after the slash is the true object size.
                    if let Some(total) = value
                        .rsplit('/')
                        .next()
                        .and_then(|t| t.trim().parse::<u64>().ok())
                    {
                        self.content_length = Some(total);
                    }
                }
                "etag" if crate::daemon::utils::is_strong_etag(value) => {
                    self.validator = Some(value.to_owned());
                    self.validator_is_etag = true;
                }
                "last-modified" if self.validator.is_none() => {
                    self.validator = Some(value.to_owned());
                    self.validator_is_etag = false;
                }
                _ => {}
            }
        }
        true
    }
}
impl HtmlHeadCapture {
    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub(crate) fn http_version(&self) -> Option<String> {
        self.http_version.lock().ok().and_then(|v| v.clone())
    }
    pub(crate) fn content_length(&self) -> Option<u64> {
        self.content_length
    }
    pub(crate) fn validator(&self) -> Option<(String, bool)> {
        self.validator
            .clone()
            .map(|value| (value, self.validator_is_etag))
    }
}

static CA_BUNDLE_PATH: OnceLock<String> = OnceLock::new();

fn installed_ca_bundle_path() -> &'static str {
    CA_BUNDLE_PATH.get_or_init(|| {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(parent) = exe_path.parent() {
                let candidate = parent.join("cacert.pem");
                if candidate.exists() {
                    return candidate.display().to_string();
                }
            }
        }
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let candidate = manifest.join("cacert.pem");
        if candidate.exists() {
            return candidate.display().to_string();
        }
        String::new()
    })
}

/// Returns true when the URL scheme requires TLS certificate verification
/// against a CA bundle AND the linked TLS backend has no operating-system
/// trust store to fall back on. Schannel (Windows) and `SecureTransport`
/// (macOS) verify against the OS store; OpenSSL and most other backends on
/// Windows have no default trust path, so a missing cacert.pem means every
/// HTTPS handshake fails (historically surfacing as the silent
/// `response_code=0` "completed with 0 bytes" bug).
fn tls_backend_needs_explicit_ca() -> bool {
    let version = ::curl::Version::get();
    let ssl = version.ssl_version().unwrap_or("");
    !(ssl.contains("Schannel") || ssl.contains("SecureTransport"))
}

fn url_requires_explicit_ca(url: &str, insecure: bool) -> bool {
    if insecure {
        return false;
    }
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("ftps://"))
        && tls_backend_needs_explicit_ca()
}

static SSL_INIT: OnceLock<()> = OnceLock::new();

pub fn init_download_ssl() {
    SSL_INIT.get_or_init(|| {
        let ca_path = installed_ca_bundle_path();
        if !ca_path.is_empty() {
            log::info!("curl SSL using bundled CA: {ca_path}");
        } else if tls_backend_needs_explicit_ca() {
            log::error!(
                "No bundled CA certificate found and the TLS backend ({}) has no OS trust store; \
                 verified HTTPS downloads will fail with a clear error instead of silently \
                 completing with zero bytes. Restore cacert.pem next to the executable.",
                ::curl::Version::get().ssl_version().unwrap_or("unknown")
            );
        } else {
            log::info!(
                "No bundled CA certificate found; using the operating system trust store ({}).",
                ::curl::Version::get().ssl_version().unwrap_or("unknown")
            );
        }

        let build_link_mode = option_env!("NOVA_BUILD_LIBCURL_LINK_MODE").unwrap_or("unknown");
        let build_prefix = option_env!("NOVA_BUILD_LIBCURL_PREFIX").unwrap_or("unknown");
        if build_link_mode.contains("fallback") || build_prefix == "unmanaged" {
            log::warn!(
                "NOVA libcurl runtime: using fallback/system libcurl (link_mode={build_link_mode}, prefix={build_prefix}). \
                 Native statically-built libcurl is not linked. TLS backend and protocol support \
                 may differ from production builds."
            );
        }
    });
}

fn if_range_header(plan: &DirectDownloadPlan) -> Option<String> {
    let validator = plan.validator.as_ref()?;
    if plan.validator_is_etag {
        if crate::daemon::utils::is_strong_etag(validator) {
            Some(format!("If-Range: {validator}"))
        } else {
            None
        }
    } else {
        Some(format!("If-Range: {validator}"))
    }
}

fn requires_identity_encoding(
    resumable: bool,
    output_path: &Path,
    range: Option<(u64, u64)>,
) -> Result<bool, String> {
    // Byte-range offsets are defined against the selected representation. A
    // transparent Content-Encoding changes the bytes libcurl writes to disk,
    // so a resumed/segmented transfer can no longer prove that its local byte
    // offsets correspond to the remote object. Force the identity
    // representation whenever an explicit Range is used or an existing
    // destination is being resumed.
    if range.is_some() {
        return Ok(true);
    }
    Ok(resumable && FileWriter::current_size(output_path)? > 0)
}

fn direct_headers(
    config: &CurlTransferConfig,
    force_identity_encoding: bool,
) -> Result<Option<List>, String> {
    let mut list = List::new();
    let mut has_any = false;
    if let Some(raw_headers) = config.str_("headers") {
        for line in raw_headers
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if line.contains(':') {
                if !safe_value(line) {
                    return Err("Rejected unsafe header value".to_owned());
                }
                let is_accept_encoding = line
                    .split_once(':')
                    .is_some_and(|(name, _)| name.trim().eq_ignore_ascii_case("accept-encoding"));
                if force_identity_encoding && is_accept_encoding {
                    // A caller-supplied gzip/br header would override the
                    // range-safe identity representation. Ignore it only for
                    // resumable/range transfers; fresh single-connection
                    // downloads retain the caller's requested encoding.
                    continue;
                }
                list.append(line)
                    .map_err(|e| format!("Could not apply header: {e}"))?;
                has_any = true;
            }
        }
    }
    Ok(if has_any { Some(list) } else { None })
}

pub fn apply_easy_options<H: Handler>(
    easy: &mut Easy2<H>,
    plan: &DirectDownloadPlan,
    range: Option<(u64, u64)>,
) -> Result<(), String> {
    easy.url(&plan.url)
        .map_err(|e| format!("Invalid URL: {e}"))?;
    easy.get(true)
        .map_err(|e| format!("Could not configure GET: {e}"))?;
    easy.follow_location(plan.follow_redirects)
        .map_err(|e| format!("Could not configure redirects: {e}"))?;
    easy.fail_on_error(plan.fail_on_error)
        .map_err(|e| format!("Could not configure fail-on-error: {e}"))?;
    easy.progress(true)
        .map_err(|e| format!("Could not enable progress callback: {e}"))?;
    if plan.config.u64_("maxRedirs").is_none() {
        easy.max_redirections(20)
            .map_err(|e| format!("Could not configure default redirect limit: {e}"))?;
    }
    easy.autoreferer(true)
        .map_err(|e| format!("Could not enable auto-referer: {e}"))?;
    easy.tcp_keepalive(true)
        .map_err(|e| format!("Could not enable TCP keepalive: {e}"))?;

    let mut conditional_headers: Vec<String> = Vec::new();
    let force_identity_encoding =
        requires_identity_encoding(plan.resumable, &plan.output_path, range)?;

    if let Some((start, end)) = range {
        easy.range(&format!("{start}-{end}"))
            .map_err(|e| format!("Could not configure range: {e}"))?;
    } else if plan.resumable {
        let existing = FileWriter::current_size(&plan.output_path)?;
        if existing > 0 {
            easy.resume_from(existing)
                .map_err(|e| format!("Could not configure resume: {e}"))?;
        }
    }
    if let Some(val) = if_range_header(plan) {
        conditional_headers.push(val);
    }

    if let Some(proxy) = plan.config.str_("proxy") {
        if proxy_resolves_to_internal(proxy) {
            return Err("Rejected proxy pointing to internal address".into());
        }
        easy.proxy(proxy)
            .map_err(|e| format!("Could not configure proxy: {e}"))?;
    }
    if let Some(pre_proxy) = plan.config.str_("preProxy") {
        if proxy_resolves_to_internal(pre_proxy) {
            return Err("Rejected pre-proxy pointing to internal address".into());
        }
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_PRE_PROXY, pre_proxy)
                .map_err(|e| format!("Could not configure pre-proxy: {e}"))?;
        }
    }
    if let Some(no_proxy) = plan.config.str_("noproxy") {
        easy.noproxy(no_proxy)
            .map_err(|e| format!("Could not configure noproxy: {e}"))?;
    }
    if let Some(interface) = plan
        .config
        .str_("sourceAddress")
        .or_else(|| plan.config.str_("interface"))
    {
        easy.interface(interface)
            .map_err(|e| format!("Could not bind source interface: {e}"))?;
    }
    let user_agent = plan.config.str_("userAgent").unwrap_or(DEFAULT_USER_AGENT);
    easy.useragent(user_agent)
        .map_err(|e| format!("Could not configure user-agent: {e}"))?;
    // Only send a Referer when the caller explicitly provided one. Do NOT
    // synthesize a self-referer (the download URL itself) or a bare origin
    // fallback: several real-world servers (e.g. thinkbroadband.com) reject
    // any request carrying a Referer header with 403, which broke downloads
    // that work fine in plain curl with no Referer at all. Callers that need
    // a Referer (hotlink-protected CDNs, browser-captured pages) set
    // `plan.referer` explicitly.
    if let Some(referer) = plan.referer.as_deref() {
        easy.referer(referer)
            .map_err(|e| format!("Could not configure referer: {e}"))?;
    }
    if let Some(cookies) = plan.config.str_("cookies") {
        easy.cookie(cookies)
            .map_err(|e| format!("Could not configure cookies: {e}"))?;
    }
    if force_identity_encoding {
        easy.accept_encoding("identity")
            .map_err(|e| format!("Could not force identity encoding for range-safe transfer: {e}"))?;
    } else if plan.config.bool_("compressed") != Some(false) {
        easy.accept_encoding("")
            .map_err(|e| format!("Could not enable compression: {e}"))?;
    }
    if plan.config.bool_("insecure") == Some(true) {
        log::warn!(
            "TLS verification disabled via 'insecure' option for download from {}",
            plan.url
        );
        easy.ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable TLS peer verification: {e}"))?;
        easy.ssl_verify_host(false)
            .map_err(|e| format!("Could not disable TLS host verification: {e}"))?;
    }
    if let Some(ca) = plan.config.str_("caCert") {
        easy.cainfo(ca)
            .map_err(|e| format!("Could not configure CA file: {e}"))?;
    } else if !installed_ca_bundle_path().is_empty() {
        if let Err(e) = easy.cainfo(installed_ca_bundle_path()) {
            // A cainfo setopt failure on a verified TLS transfer is fatal for
            // backends that have no system trust store to fall back on.
            if url_requires_explicit_ca(&plan.url, plan.config.bool_("insecure") == Some(true)) {
                return Err(format!(
                    "TLS configuration failed: could not load the bundled CA certificate store ({e}). \
                     HTTPS downloads cannot be verified. Reinstall NOVA or provide a valid caCert option."
                ));
            }
            log::warn!("Could not set bundled CA file: {e}");
        }
    }
    // Hard fail (instead of the historical silent response_code=0 "success")
    // when an HTTPS transfer must be verified but no trust store exists at
    // all. Backends such as Schannel/SecureTransport use the OS trust store
    // and do not need a bundle.
    if url_requires_explicit_ca(&plan.url, plan.config.bool_("insecure") == Some(true))
        && plan.config.str_("caCert").is_none()
        && installed_ca_bundle_path().is_empty()
    {
        return Err(format!(
            "TLS is not configured: no CA certificate bundle was found next to the application \
             or in the application directory, and the TLS backend ({}) does not use the operating \
             system trust store. HTTPS downloads would fail. Reinstall NOVA to restore cacert.pem.",
            ::curl::Version::get().ssl_version().unwrap_or("unknown")
        ));
    }
    if let Some(doh) = plan.config.str_("dohUrl") {
        easy.doh_url(Some(doh))
            .map_err(|e| format!("Could not configure DNS-over-HTTPS: {e}"))?;
    }
    if let Some(dns) = plan.config.str_("dnsServers") {
        easy.dns_servers(dns)
            .map_err(|e| format!("Could not configure DNS servers: {e}"))?;
    }
    if let Some(dns_iface) = plan.config.str_("dnsInterface") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_DNS_INTERFACE, dns_iface)
                .map_err(|e| format!("Could not configure DNS interface: {e}"))?;
        }
    }
    if let Some(proto) = plan.config.str_("proto") {
        reject_unsafe_protocols(proto, "proto")?;
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_PROTOCOLS_STR, proto)
                .map_err(|e| format!("Could not configure allowed protocols: {e}"))?;
        }
    }
    if let Some(proto_redir) = plan.config.str_("protoRedir") {
        reject_unsafe_protocols(proto_redir, "protoRedir")?;
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_REDIR_PROTOCOLS_STR, proto_redir)
                .map_err(|e| format!("Could not configure redirect protocols: {e}"))?;
        }
    }
    if let Some(sec) = plan.config.u64_("dnsCacheTimeoutSec") {
        easy.dns_cache_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure DNS cache timeout: {e}"))?;
    }
    if let Some(jar) = plan.config.str_("cookieJar") {
        if jar.contains("..") || jar.starts_with('/') || jar.starts_with('\\') {
            return Err(
                "cookieJar path must be a relative path within the working directory".to_owned(),
            );
        }
        easy.cookie_jar(jar)
            .map_err(|e| format!("Could not configure cookie jar: {e}"))?;
    }
    if let Some(pubkey) = plan.config.str_("pinnedPubKey") {
        easy.pinned_public_key(pubkey)
            .map_err(|e| format!("Could not configure certificate pinning: {e}"))?;
    }
    if let Some(size) = plan.config.u64_("maxFilesize").filter(|v| *v > 0) {
        easy.max_filesize(size)
            .map_err(|e| format!("Could not configure max file size: {e}"))?;
    }
    if let Some(size) = plan.config.u64_("bufferSize").filter(|v| *v > 0) {
        easy.buffer_size(size as usize)
            .map_err(|e| format!("Could not configure buffer size: {e}"))?;
    }
    if let Some(speed) = configured_speed_limit_bytes(&plan.config).filter(|v| *v > 0) {
        easy.max_recv_speed(speed)
            .map_err(|e| format!("Could not configure speed limit: {e}"))?;
    } else if let Some(rate_str) = plan.config.str_("rate") {
        if let Some(rate_bytes) = parse_rate_to_bytes(rate_str) {
            easy.max_recv_speed(rate_bytes)
                .map_err(|e| format!("Could not configure rate limit: {e}"))?;
        }
    }
    if let Some(limit) = plan.config.u64_("lowSpeedLimitBytes").filter(|v| *v > 0) {
        easy.low_speed_limit(limit.min(u64::from(u32::MAX)) as u32)
            .map_err(|e| format!("Could not configure low-speed limit: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("speedTimeSec").filter(|v| *v > 0) {
        easy.low_speed_time(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure low-speed time: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("timeoutSec").filter(|v| *v > 0) {
        easy.timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure timeout: {e}"))?;
    } else {
        // Default overall timeout: without this, a transfer that hangs in the
        // multi socket interface (e.g., stuck DNS, TLS handshake stall, or a
        // server that accepts the connection but never sends data) runs forever.
        // The hard cap comes from global_config so the engine can tune it.
        // For known-size files: at least 10 KB/s average + 60s grace.
        // For unknown-size files: 1 hour hard cap.
        let max_default = global_config().default_timeout_sec;
        let default_timeout = if plan.total_size > 0 {
            let estimated = (plan.total_size / 10_000) + 60;
            estimated.clamp(120, max_default)
        } else {
            max_default.min(3600)
        };
        easy.timeout(Duration::from_secs(default_timeout))
            .map_err(|e| format!("Could not configure default timeout: {e}"))?;
    }
    if let Some(sec) = plan.config.u64_("connectTimeoutSec").filter(|v| *v > 0) {
        easy.connect_timeout(Duration::from_secs(sec))
            .map_err(|e| format!("Could not configure connect timeout: {e}"))?;
    }
    if let Some(max) = plan.config.u64_("maxRedirs") {
        easy.max_redirections(max.min(u64::from(u32::MAX)) as u32)
            .map_err(|e| format!("Could not configure redirect limit: {e}"))?;
    }
    if plan.config.u64_("connectTimeoutSec").is_none() {
        easy.connect_timeout(Duration::from_secs(30))
            .map_err(|e| format!("Could not configure default connect timeout: {e}"))?;
    }
    // A15: no implicit low-speed abort. The old default of
    // `low_speed_limit(500 B/s for 15s)` killed legitimate slow downloads
    // (e.g. a capped connection or a throttled server). The low-speed abort
    // is only applied when the user explicitly configures
    // `lowSpeedLimitBytes`/`speedTimeSec` in the plan below.
    if let Some(user) = plan.config.str_("username") {
        easy.username(user)
            .map_err(|e| format!("Could not configure username: {e}"))?;
    }
    if let Some(pass) = plan.config.str_("password") {
        easy.password(pass)
            .map_err(|e| format!("Could not configure password: {e}"))?;
    }
    if let Some(auth_type) = plan.config.str_("authType") {
        let mut auth = Auth::new();
        let lower = auth_type.to_ascii_lowercase();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" => {
                auth.auto(true);
            }
            _ => {
                auth.basic(true);
            }
        }
        easy.http_auth(&auth)
            .map_err(|e| format!("Could not configure HTTP auth: {e}"))?;
    }
    if let Some(netrc_val) = plan.config.str_("netrc") {
        let lower = netrc_val.to_ascii_lowercase();
        match lower.as_str() {
            "optional" | "yes" => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "required" | "true" | "on" => easy
                .netrc(NetRc::Required)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            "no" | "false" | "off" | "ignored" => easy
                .netrc(NetRc::Ignored)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
            _ => easy
                .netrc(NetRc::Optional)
                .map_err(|e| format!("Could not configure netrc: {e}"))?,
        }
    }
    if plan.config.bool_("netrcOptional") == Some(true) {
        easy.netrc(NetRc::Optional)
            .map_err(|e| format!("Could not configure netrc-optional: {e}"))?;
    }
    if let Some(netrc_file) = plan.config.str_("netrcFile") {
        // Reject paths with traversal or pointing to system locations.
        if netrc_file.contains("..") || netrc_file.starts_with('/') || netrc_file.starts_with('\\')
        {
            return Err(
                "netrcFile path must be a relative path within the working directory".to_owned(),
            );
        }
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_NETRC_FILE, netrc_file)
                .map_err(|e| format!("Could not configure netrc file: {e}"))?;
        }
    }
    if let Some(cert) = plan.config.str_("cert") {
        if cert.contains("..") || cert.starts_with('/') || cert.starts_with('\\') {
            return Err(
                "cert path must be a relative path within the working directory".to_owned(),
            );
        }
        easy.ssl_cert(cert)
            .map_err(|e| format!("Could not configure SSL certificate: {e}"))?;
    }
    if let Some(cert_type) = plan.config.str_("certType") {
        easy.ssl_cert_type(cert_type)
            .map_err(|e| format!("Could not configure certificate type: {e}"))?;
    }
    if let Some(key) = plan.config.str_("key") {
        if key.contains("..") || key.starts_with('/') || key.starts_with('\\') {
            return Err("key path must be a relative path within the working directory".to_owned());
        }
        easy.ssl_key(key)
            .map_err(|e| format!("Could not configure SSL key: {e}"))?;
    }
    if let Some(key_type) = plan.config.str_("keyType") {
        easy.ssl_key_type(key_type)
            .map_err(|e| format!("Could not configure key type: {e}"))?;
    }
    if let Some(key_pass) = plan.config.str_("pass") {
        easy.key_password(key_pass)
            .map_err(|e| format!("Could not configure key password: {e}"))?;
    }
    if let Some(ciphers) = plan.config.str_("ciphers") {
        easy.ssl_cipher_list(ciphers)
            .map_err(|e| format!("Could not configure TLS cipher list: {e}"))?;
    }
    if let Some(tls13_ciphers) = plan.config.str_("tls13Ciphers") {
        unsafe {
            raw_setopt_str(easy.raw(), CURLOPT_TLS13_CIPHERS, tls13_ciphers)
                .map_err(|e| format!("Could not configure TLS 1.3 ciphers: {e}"))?;
        }
    }
    if let Some(tls_max) = plan.config.str_("tlsMax") {
        let lower = tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure TLS max version: {e}"))?;
        }
    }
    if let Some(ca_path) = plan.config.str_("caPath") {
        easy.capath(ca_path)
            .map_err(|e| format!("Could not configure CA path: {e}"))?;
    }
    if plan.config.bool_("sslReqd") == Some(true) {
        easy.ssl_verify_peer(true)
            .map_err(|e| format!("Could not enable SSL peer verification: {e}"))?;
        easy.ssl_verify_host(true)
            .map_err(|e| format!("Could not enable SSL host verification: {e}"))?;
    }
    if let Some(proxy_user) = plan.config.str_("proxyUser") {
        easy.proxy_username(proxy_user)
            .map_err(|e| format!("Could not configure proxy username: {e}"))?;
        if let Some(proxy_pass) = plan.config.str_("proxyPassword") {
            easy.proxy_password(proxy_pass)
                .map_err(|e| format!("Could not configure proxy password: {e}"))?;
        }
    }
    if let Some(proxy_auth_val) = plan.config.str_("proxyAnyAuth") {
        let lower = proxy_auth_val.to_ascii_lowercase();
        let mut auth = Auth::new();
        match lower.as_str() {
            "basic" => {
                auth.basic(true);
            }
            "digest" => {
                auth.digest(true);
            }
            "ntlm" => {
                auth.ntlm(true);
            }
            "negotiate" | "gssapi" => {
                auth.gssnegotiate(true);
            }
            "any" | "auto" => {
                auth.auto(true);
            }
            _ => {
                auth.auto(true);
            }
        }
        easy.proxy_auth(&auth)
            .map_err(|e| format!("Could not configure proxy auth: {e}"))?;
    }
    if plan.config.bool_("remoteTime") == Some(true) {
        easy.fetch_filetime(true)
            .map_err(|e| format!("Could not enable remote time fetch: {e}"))?;
    }
    if let Some(method) = plan.config.str_("requestMethod") {
        easy.custom_request(method)
            .map_err(|e| format!("Could not configure custom request method: {e}"))?;
    }
    if let Some(post_data) = plan.config.str_("data") {
        easy.post_fields_copy(post_data.as_bytes())
            .map_err(|e| format!("Could not configure POST data: {e}"))?;
    }
    if !plan.config.form.is_empty() {
        let mut form = Form::new();
        for entry in &plan.config.form {
            if let Some((name, value)) = entry.split_once('=') {
                if value.starts_with('@') {
                    let file_path = value.strip_prefix('@').unwrap_or(value);
                    let mut part = form.part(name);
                    part.file_content(file_path);
                    part.add()
                        .map_err(|e| format!("Could not add form file part '{name}': {e}"))?;
                } else {
                    let mut part = form.part(name);
                    part.contents(value.as_bytes());
                    part.add()
                        .map_err(|e| format!("Could not add form field '{name}': {e}"))?;
                }
            }
        }
        easy.httppost(form)
            .map_err(|e| format!("Could not configure multipart form data: {e}"))?;
    }
    if let Some(time_cond) = plan.config.str_("timeCond") {
        let lower = time_cond.to_ascii_lowercase();
        let cond = match lower.as_str() {
            "if-modified-since" | "modified" => Some(TimeCondition::IfModifiedSince),
            "if-unmodified-since" | "unmodified" => Some(TimeCondition::IfUnmodifiedSince),
            _ => None,
        };
        if let Some(c) = cond {
            easy.time_condition(c)
                .map_err(|e| format!("Could not configure time condition: {e}"))?;
            if let Some(ts) = plan.config.u64_("timeValue") {
                easy.time_value(ts as i64)
                    .map_err(|e| format!("Could not configure time value: {e}"))?;
            }
        }
    }
    if plan.config.bool_("tcpNoDelay") == Some(true) {
        easy.tcp_nodelay(true)
            .map_err(|e| format!("Could not enable TCP no-delay: {e}"))?;
    }
    if plan.config.bool_("pathAsIs") == Some(true) {
        easy.path_as_is(true)
            .map_err(|e| format!("Could not enable path-as-is: {e}"))?;
    }
    if plan.config.bool_("ftpCreateDirs") == Some(true) {
        unsafe {
            raw_setopt_long(easy.raw(), CURLOPT_FTP_CREATE_MISSING_DIRS, 1)
                .map_err(|e| format!("Could not enable FTP create dirs: {e}"))?;
        }
    }
    if let Some(keepalive_sec) = plan.config.u64_("keepaliveTimeSec").filter(|v| *v > 0) {
        let dur = Duration::from_secs(keepalive_sec);
        easy.tcp_keepidle(dur)
            .map_err(|e| format!("Could not configure keepalive idle time: {e}"))?;
        easy.tcp_keepintvl(dur)
            .map_err(|e| format!("Could not configure keepalive interval: {e}"))?;
    }
    let resolve_entries = plan.config.array_("resolve");
    if !resolve_entries.is_empty() {
        let mut list = List::new();
        for entry in &resolve_entries {
            // Validate the target address to prevent SSRF bypass: a "safe" URL
            // hostname could be redirected to an internal IP via a resolve entry.
            crate::daemon::utils::is_safe_resolve_entry(entry.as_str())
                .map_err(|e| format!("Rejected resolve entry '{entry}': {e}"))?;
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add DNS resolve entry: {e}"))?;
        }
        easy.resolve(list)
            .map_err(|e| format!("Could not configure DNS resolve overrides: {e}"))?;
    }
    let connect_to_entries = plan.config.array_("connectTo");
    if !connect_to_entries.is_empty() {
        let mut list = List::new();
        for entry in &connect_to_entries {
            crate::daemon::utils::is_safe_resolve_entry(entry.as_str())
                .map_err(|e| format!("Rejected connect-to entry '{entry}': {e}"))?;
            list.append(entry.as_str())
                .map_err(|e| format!("Could not add connect-to entry: {e}"))?;
        }
        easy.connect_to(list)
            .map_err(|e| format!("Could not configure connect-to overrides: {e}"))?;
    }
    if let Some(max_connects) = plan.config.u64_("maxConnects").filter(|v| *v > 0) {
        easy.max_connects(max_connects.min(u64::from(u32::MAX)) as u32)
            .map_err(|e| format!("Could not configure max connects: {e}"))?;
    }
    match plan
        .config
        .str_("httpVersion")
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "1.0" | "http1.0" => easy
            .http_version(HttpVersion::V10)
            .map_err(|e| format!("Could not force HTTP/1.0: {e}"))?,
        "1.1" | "http1.1" => easy
            .http_version(HttpVersion::V11)
            .map_err(|e| format!("Could not force HTTP/1.1: {e}"))?,
        "2" | "http2" => easy
            .http_version(HttpVersion::V2)
            .map_err(|e| format!("Could not force HTTP/2: {e}"))?,
        "2-prior-knowledge" | "http2-prior-knowledge" => easy
            .http_version(HttpVersion::V2PriorKnowledge)
            .map_err(|e| format!("Could not force HTTP/2 prior knowledge: {e}"))?,
        "3" | "http3" | "3-only" | "http3-only" => easy
            .http_version(HttpVersion::V3)
            .map_err(|e| format!("Could not force HTTP/3: {e}"))?,
        _ => {}
    }
    if let Some(ip) = plan.config.str_("ipResolve") {
        let lower = ip.to_ascii_lowercase();
        match lower.as_str() {
            "4" | "ipv4" | "4-only" => easy
                .ip_resolve(IpResolve::V4)
                .map_err(|e| format!("Could not force IPv4: {e}"))?,
            "6" | "ipv6" | "6-only" => easy
                .ip_resolve(IpResolve::V6)
                .map_err(|e| format!("Could not force IPv6: {e}"))?,
            _ => {}
        }
    }
    if let Some(tls_min) = plan.config.str_("tlsMin") {
        let lower = tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
            "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
            "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
            "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure TLS min version: {e}"))?;
        }
    }
    if let (Some(tls_min), Some(tls_max)) = (plan.config.str_("tlsMin"), plan.config.str_("tlsMax"))
    {
        let parse_ver = |s: &str| -> Option<SslVersion> {
            let l = s.to_ascii_lowercase();
            match l.as_str() {
                "1.0" | "tls1.0" | "tlsv10" => Some(SslVersion::Tlsv10),
                "1.1" | "tls1.1" | "tlsv11" => Some(SslVersion::Tlsv11),
                "1.2" | "tls1.2" | "tlsv12" => Some(SslVersion::Tlsv12),
                "1.3" | "tls1.3" | "tlsv13" => Some(SslVersion::Tlsv13),
                _ => None,
            }
        };
        if let (Some(min_v), Some(max_v)) = (parse_ver(tls_min), parse_ver(tls_max)) {
            easy.ssl_min_max_version(min_v, max_v)
                .map_err(|e| format!("Could not configure TLS version range: {e}"))?;
        }
    }
    if let Some(opts_str) = plan.config.str_("sslOptions") {
        let mut ssl_opt = SslOpt::new();
        let lower = opts_str.to_ascii_lowercase();
        if lower.contains("no-revoke") {
            ssl_opt.no_revoke(true);
        }
        if lower.contains("no-partial") {
            ssl_opt.no_partial_chain(true);
        }
        if lower.contains("native-ca") {
            ssl_opt.native_ca(true);
        }
        if lower.contains("auto-client-cert") {
            ssl_opt.auto_client_cert(true);
        }
        easy.ssl_options(&ssl_opt)
            .map_err(|e| format!("Could not configure SSL options: {e}"))?;
    }
    if let Some(crl) = plan.config.str_("crlFile") {
        if crl.contains("..") || crl.starts_with('/') || crl.starts_with('\\') {
            return Err(
                "crlFile path must be a relative path within the working directory".to_owned(),
            );
        }
        easy.crlfile(crl)
            .map_err(|e| format!("Could not configure CRL file: {e}"))?;
    }
    if let Some(issuer) = plan.config.str_("issuerCert") {
        easy.issuer_cert(issuer)
            .map_err(|e| format!("Could not configure issuer certificate: {e}"))?;
    }
    if plan.config.bool_("sslSessionIdCache") == Some(false) {
        easy.ssl_sessionid_cache(false)
            .map_err(|e| format!("Could not disable SSL session ID cache: {e}"))?;
    }
    if let Some(proxy_cainfo) = plan.config.str_("proxyCaInfo") {
        easy.proxy_cainfo(proxy_cainfo)
            .map_err(|e| format!("Could not configure proxy CA info: {e}"))?;
    }
    if let Some(proxy_capath) = plan.config.str_("proxyCaPath") {
        easy.proxy_capath(proxy_capath)
            .map_err(|e| format!("Could not configure proxy CA path: {e}"))?;
    }
    if let Some(proxy_cert) = plan.config.str_("proxyCert") {
        easy.proxy_sslcert(proxy_cert)
            .map_err(|e| format!("Could not configure proxy SSL cert: {e}"))?;
    }
    if let Some(proxy_cert_type) = plan.config.str_("proxyCertType") {
        easy.proxy_sslcert_type(proxy_cert_type)
            .map_err(|e| format!("Could not configure proxy cert type: {e}"))?;
    }
    if let Some(proxy_key) = plan.config.str_("proxyKey") {
        easy.proxy_sslkey(proxy_key)
            .map_err(|e| format!("Could not configure proxy SSL key: {e}"))?;
    }
    if let Some(proxy_key_type) = plan.config.str_("proxyKeyType") {
        easy.proxy_sslkey_type(proxy_key_type)
            .map_err(|e| format!("Could not configure proxy key type: {e}"))?;
    }
    if let Some(proxy_key_pass) = plan.config.str_("proxyKeyPassword") {
        easy.proxy_key_password(proxy_key_pass)
            .map_err(|e| format!("Could not configure proxy key password: {e}"))?;
    }
    if let Some(proxy_cipher) = plan.config.str_("proxyCiphers") {
        easy.proxy_ssl_cipher_list(proxy_cipher)
            .map_err(|e| format!("Could not configure proxy cipher list: {e}"))?;
    }
    if let Some(proxy_tls_max) = plan.config.str_("proxyTlsMax") {
        let lower = proxy_tls_max.to_ascii_lowercase();
        let max_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = max_ver {
            easy.proxy_ssl_min_max_version(SslVersion::Default, ver)
                .map_err(|e| format!("Could not configure proxy TLS max version: {e}"))?;
        }
    }
    if let Some(proxy_tls_min) = plan.config.str_("proxyTlsMin") {
        let lower = proxy_tls_min.to_ascii_lowercase();
        let min_ver = match lower.as_str() {
            "1.0" => Some(SslVersion::Tlsv10),
            "1.1" => Some(SslVersion::Tlsv11),
            "1.2" => Some(SslVersion::Tlsv12),
            "1.3" => Some(SslVersion::Tlsv13),
            _ => None,
        };
        if let Some(ver) = min_ver {
            easy.proxy_ssl_min_max_version(ver, SslVersion::Default)
                .map_err(|e| format!("Could not configure proxy TLS min version: {e}"))?;
        }
    }
    if plan.config.bool_("proxyVerifyPeer") == Some(false) {
        easy.proxy_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable proxy peer verification: {e}"))?;
    }
    if plan.config.bool_("proxyVerifyHost") == Some(false) {
        easy.proxy_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable proxy host verification: {e}"))?;
    }
    if let Some(proxy_type_val) = plan.config.str_("proxyType") {
        let lower = proxy_type_val.to_ascii_lowercase();
        let pt = match lower.as_str() {
            "socks4" => Some(ProxyType::Socks4),
            "socks5" => Some(ProxyType::Socks5),
            "socks4a" => Some(ProxyType::Socks4a),
            "socks5h" => Some(ProxyType::Socks5Hostname),
            _ => None,
        };
        if let Some(pt_val) = pt {
            easy.proxy_type(pt_val)
                .map_err(|e| format!("Could not configure proxy type: {e}"))?;
        }
    }
    if plan.config.bool_("proxyTunnel") == Some(true) {
        easy.http_proxy_tunnel(true)
            .map_err(|e| format!("Could not enable proxy tunnel: {e}"))?;
    }
    if plan.config.bool_("unrestrictedAuth") == Some(true) {
        easy.unrestricted_auth(true)
            .map_err(|e| format!("Could not enable unrestricted auth: {e}"))?;
    }
    if plan.config.bool_("transferEncoding") == Some(true) {
        easy.transfer_encoding(true)
            .map_err(|e| format!("Could not enable transfer encoding: {e}"))?;
    }
    if plan.config.bool_("http09Allowed") == Some(true) {
        easy.http_09_allowed(true)
            .map_err(|e| format!("Could not enable HTTP/0.9: {e}"))?;
    }
    if let Some(timeout) = plan.config.u64_("expect100TimeoutMs") {
        easy.expect_100_timeout(Duration::from_millis(timeout))
            .map_err(|e| format!("Could not configure expect-100 timeout: {e}"))?;
    }
    if plan.config.bool_("freshConnect") == Some(true) {
        easy.fresh_connect(true)
            .map_err(|e| format!("Could not force fresh connection: {e}"))?;
    }
    if plan.config.bool_("forbidReuse") == Some(true) {
        easy.forbid_reuse(true)
            .map_err(|e| format!("Could not forbid connection reuse: {e}"))?;
    }
    if let Some(age) = plan.config.u64_("maxAgeConn") {
        easy.maxage_conn(Duration::from_secs(age))
            .map_err(|e| format!("Could not configure max connection age: {e}"))?;
    }
    if let Some(range) = plan.config.str_("localPortRange") {
        if let Some((start_str, end_str)) = range.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (
                start_str.trim().parse::<u16>(),
                end_str.trim().parse::<u16>(),
            ) {
                if hi >= lo {
                    easy.set_local_port(lo)
                        .map_err(|err| format!("Could not configure local port: {err}"))?;
                    easy.local_port_range(hi - lo + 1)
                        .map_err(|err| format!("Could not configure local port range: {err}"))?;
                }
            }
        }
    }
    if plan.config.bool_("dohSslVerifyPeer") == Some(false) {
        easy.doh_ssl_verify_peer(false)
            .map_err(|e| format!("Could not disable DoH peer verification: {e}"))?;
    }
    if plan.config.bool_("dohSslVerifyHost") == Some(false) {
        easy.doh_ssl_verify_host(false)
            .map_err(|e| format!("Could not disable DoH host verification: {e}"))?;
    }
    let mut header_list: List =
        if let Some(headers) = direct_headers(&plan.config, force_identity_encoding)? {
        headers
    } else {
        let mut list = List::new();
        list.append("Accept: */*")
            .map_err(|e| format!("Could not add Accept header: {e}"))?;
        list.append("Accept-Language: en-US,en;q=0.9")
            .map_err(|e| format!("Could not add Accept-Language header: {e}"))?;
        list.append("Cache-Control: no-store")
            .map_err(|e| format!("Could not add Cache-Control header: {e}"))?;
        list.append("Connection: keep-alive")
            .map_err(|e| format!("Could not add Connection header: {e}"))?;
        list.append("Sec-Fetch-Mode: no-cors")
            .map_err(|e| format!("Could not add Sec-Fetch-Mode header: {e}"))?;
        list.append("Sec-Fetch-Site: cross-site")
            .map_err(|e| format!("Could not add Sec-Fetch-Site header: {e}"))?;
        list.append("Sec-Fetch-Dest: empty")
            .map_err(|e| format!("Could not add Sec-Fetch-Dest header: {e}"))?;
        if plan.digest_sha256.is_none() {
            list.append("Want-Digest: sha-256")
                .map_err(|e| format!("Could not add Want-Digest header: {e}"))?;
            list.append("Want-Content-Digest: sha-256")
                .map_err(|e| format!("Could not add Want-Content-Digest header: {e}"))?;
        }
        if let Some(bearer) = plan.config.str_("oauth2Bearer") {
            list.append(&format!("Authorization: Bearer {bearer}"))
                .map_err(|e| format!("Could not add OAuth2 bearer header: {e}"))?;
        }
        list
    };
    for hdr in &conditional_headers {
        header_list
            .append(hdr)
            .map_err(|e| format!("Could not add conditional header: {e}"))?;
    }
    if let Some(etag_file) = plan.config.str_("etagCompare") {
        if let Ok(etag_value) = std::fs::read_to_string(etag_file) {
            let etag_value = etag_value.trim().to_owned();
            if !etag_value.is_empty() {
                header_list
                    .append(&format!("If-None-Match: {etag_value}"))
                    .map_err(|e| format!("Could not add If-None-Match header: {e}"))?;
            }
        }
    }
    easy.http_headers(header_list)
        .map_err(|e| format!("Could not configure HTTP headers: {e}"))?;
    Ok(())
}

pub fn create_easy_for_range_ext(
    plan: &DirectDownloadPlan,
    path: &Path,
    progress: SegmentProgress,
    range: Option<(u64, u64)>,
    bandwidth_limit: Option<u64>,
) -> Result<Easy2<SegmentWriter>, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create segment folder: {e}"))?;
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("Could not open segment output file: {e}"))?;
    if file.metadata().map_or(0, |m| m.len()) > 0 {
        // Resume path: keep writing after the existing bytes. Without O_APPEND
        // the cursor starts at 0, so seek to the current end explicitly.
        let _ = file
            .seek(SeekFrom::End(0))
            .map_err(|e| format!("Could not position segment file for resume: {e}"))?;
    }
    let mut easy = Easy2::new(SegmentWriter {
        file,
        progress,
        streaming_hasher: None,
    });
    apply_easy_options(&mut easy, plan, range)?;
    if let Some(limit) = bandwidth_limit.filter(|l| *l > 0) {
        easy.max_recv_speed(limit)
            .map_err(|e| format!("Could not configure bandwidth limit: {e}"))?;
    }
    Ok(easy)
}

/// Apply (or clear) a live per-handle download cap on a raw curl handle.
/// `None` means unlimited; `Some(0)` is treated as unlimited too because
/// libcurl interprets 0 as "no limit". Returns the previous setting for restore.
pub fn set_live_rate(easy: *mut curl_sys::CURL, limit: Option<u64>) -> Result<(), String> {
    let bps = limit.unwrap_or(0);
    let code =
        unsafe { curl_sys::curl_easy_setopt(easy, curl_sys::CURLOPT_MAX_RECV_SPEED_LARGE, bps) };
    if code == curl_sys::CURLE_OK {
        Ok(())
    } else {
        Err(format!("Could not set live rate limit: curl code {code}"))
    }
}

/// Reject curl protocol lists that include schemes which could read local files
/// or reach the local network. The curl syntax is a comma- or space-separated
/// list of protocol names (e.g. "http,https,ftp").
fn reject_unsafe_protocols(value: &str, field: &str) -> Result<(), String> {
    const FORBIDDEN: &[&str] = &[
        "file", "gopher", "scp", "smb", "smbs", "telnet", "dict", "ldap", "tftp", "gophers",
        "imap", "imaps", "smtp", "smtps",
    ];
    let lower = value.to_lowercase();
    for &bad in FORBIDDEN {
        // Match either comma- or space-separated tokens.
        for token in lower.split(|c: char| c == ',' || c.is_whitespace()) {
            if token == bad {
                return Err(format!(
                    "Protocol '{bad}' is not allowed in curl '{field}' option (would bypass local-file protections)"
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::curl::ResponseCapture;
    use std::sync::{Arc, Mutex};

    fn segment_writer() -> SegmentWriter {
        let dir = std::env::temp_dir().join(format!("nova_easy_cfg_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(dir.join("hdr.bin"))
            .unwrap();
        let progress = SegmentProgress {
            downloaded: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            abort: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            retry_after: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            capture: Arc::new(Mutex::new(ResponseCapture::default())),
            streaming_digest_out: Arc::new(Mutex::new(None)),
            range_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            encoding_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            expects_206: false,
        };
        SegmentWriter {
            file,
            progress,
            streaming_hasher: None,
        }
    }

    fn captured(w: &SegmentWriter) -> ResponseCapture {
        w.progress.capture.lock().unwrap().clone()
    }

    #[test]
    fn write_callback_counts_only_bytes_successfully_written_to_disk() {
        // Unique, Windows-safe file name per test: tests run in parallel and
        // the shared segment_writer() helper truncates the same hdr.bin,
        // which would make the on-disk-size assertions a race. The test
        // thread name contains colons (invalid in a Windows filename), so
        // uniqueness comes from the system clock nanos + a per-test prefix.
        let dir = std::env::temp_dir().join(format!("nova_easy_cfg_count_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let path = dir.join(format!("count_{nanos}.bin"));
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .unwrap();
        let progress = SegmentProgress {
            downloaded: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            abort: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            retry_after: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            capture: Arc::new(Mutex::new(ResponseCapture::default())),
            streaming_digest_out: Arc::new(Mutex::new(None)),
            range_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            encoding_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            expects_206: false,
        };
        let mut w = SegmentWriter {
            file,
            progress,
            streaming_hasher: None,
        };
        let chunk = vec![7u8; 4096];
        assert_eq!(w.write(&chunk).unwrap(), 4096);
        // The counter increments ONLY after write_all succeeded — it is a
        // count of bytes actually handed to the file descriptor, so it must
        // equal the on-disk size of the part file, byte for byte.
        assert_eq!(
            w.progress.downloaded.load(Ordering::Relaxed),
            4096,
            "write counter must equal bytes written"
        );
        assert_eq!(
            w.file.metadata().unwrap().len(),
            4096,
            "part file must contain exactly the counted bytes"
        );
        // A second chunk accumulates monotonically and stays in lockstep with
        // the file size — progress cannot drift from real disk bytes.
        assert_eq!(w.write(&chunk).unwrap(), 4096);
        assert_eq!(w.progress.downloaded.load(Ordering::Relaxed), 8192);
        assert_eq!(w.file.metadata().unwrap().len(), 8192);

        // After abort, write_all must not run: no bytes written, no counter
        // movement. This is what prevents fake progress on a dead segment.
        w.progress.abort.store(true, Ordering::Relaxed);
        assert_eq!(w.write(&chunk).unwrap(), 0);
        assert_eq!(w.progress.downloaded.load(Ordering::Relaxed), 8192);
        assert_eq!(w.file.metadata().unwrap().len(), 8192);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_callback_resume_offset_matches_disk_then_accumulates() {
        // Resume scenario: the part file already holds `existing` bytes on
        // disk and the writer was opened in append mode (seek-to-end). A
        // fresh segment counter starts at 0; the caller adds `existing` on
        // top. The invariant to preserve is that counter + existing always
        // equals the on-disk length. Unique, Windows-safe file path — see
        // the sibling test.
        let dir = std::env::temp_dir().join(format!("nova_easy_cfg_resume_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos();
        let path = dir.join(format!("resume_{nanos}.bin"));
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&path)
            .unwrap();
        let progress = SegmentProgress {
            downloaded: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            abort: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            retry_after: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            capture: Arc::new(Mutex::new(ResponseCapture::default())),
            streaming_digest_out: Arc::new(Mutex::new(None)),
            range_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            encoding_rejected: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            expects_206: false,
        };
        let mut w = SegmentWriter {
            file,
            progress,
            streaming_hasher: None,
        };
        let pre = vec![1u8; 1000];
        assert_eq!(w.write(&pre).unwrap(), 1000);
        let existing = w.file.metadata().unwrap().len();
        assert_eq!(existing, 1000);

        let mut resume = w;
        let more = vec![2u8; 500];
        assert_eq!(resume.write(&more).unwrap(), 500);
        let written = resume.progress.downloaded.load(Ordering::Relaxed);
        let on_disk = resume.file.metadata().unwrap().len();
        assert_eq!(written, 1500, "counter accumulates across the resume");
        assert_eq!(on_disk, 1500, "disk length stays in lockstep");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn header_callback_captures_content_length_for_unknown_size_transfers() {
        let mut w = segment_writer();
        assert!(w.header(b"HTTP/1.1 200 OK\r\n"));
        assert!(w.header(b"Content-Length: 10485760\r\n"));
        assert!(w.header(b"Connection: close\r\n"));
        let cap = captured(&w);
        assert_eq!(cap.content_length, Some(10 * 1024 * 1024));
        assert!(!cap.content_encoded);
    }

    #[test]
    fn header_callback_captures_content_range_total() {
        let mut w = segment_writer();
        assert!(w.header(b"HTTP/1.1 206 Partial Content\r\n"));
        assert!(w.header(b"Content-Range: bytes 0-1023/2048\r\n"));
        assert!(w.header(b"Content-Length: 1024\r\n"));
        // 206 responses: the Content-Length is the segment size, so the total
        // from Content-Range must win.
        let cap = captured(&w);
        assert_eq!(cap.content_length, Some(2048));
    }

    #[test]
    fn header_callback_marks_content_encoded_transfers() {
        let mut w = segment_writer();
        assert!(w.header(b"HTTP/1.1 200 OK\r\n"));
        assert!(w.header(b"Content-Encoding: gzip\r\n"));
        assert!(w.header(b"Content-Length: 512\r\n"));
        let cap = captured(&w);
        assert!(cap.content_encoded);
        // Content-Length is the compressed size; the transfer must not expose
        // it as the total for progress purposes when encoding is active.
        assert_eq!(cap.content_length, Some(512));
    }

    #[test]
    fn header_callback_ignores_malformed_content_length() {
        let mut w = segment_writer();
        assert!(w.header(b"HTTP/1.1 200 OK\r\n"));
        assert!(w.header(b"Content-Length: not-a-number\r\n"));
        assert!(w.header(b"Content-Range: bytes 0-9/*\r\n"));
        let cap = captured(&w);
        assert_eq!(cap.content_length, None);
    }

    #[test]
    fn preflight_capture_prefers_strong_etag_over_last_modified() {
        let mut capture = HtmlHeadCapture::default();
        assert!(capture.header(b"HTTP/1.1 206 Partial Content\r\n"));
        assert!(capture.header(b"Last-Modified: Wed, 23 Sep 2026 20:00:00 GMT\r\n"));
        assert!(capture.header(b"ETag: \"nova-v2\"\r\n"));
        assert_eq!(
            capture.validator(),
            Some(("\"nova-v2\"".to_owned(), true))
        );
    }

    #[test]
    fn preflight_capture_uses_last_modified_when_no_strong_etag_exists() {
        let mut capture = HtmlHeadCapture::default();
        assert!(capture.header(b"HTTP/1.1 206 Partial Content\r\n"));
        assert!(capture.header(b"ETag: W/\"weak-nova\"\r\n"));
        assert!(capture.header(b"Last-Modified: Wed, 23 Sep 2026 20:00:00 GMT\r\n"));
        assert_eq!(
            capture.validator(),
            Some(("Wed, 23 Sep 2026 20:00:00 GMT".to_owned(), false))
        );
    }

    #[test]
    fn preflight_capture_resets_identity_across_http_responses() {
        let mut capture = HtmlHeadCapture::default();
        assert!(capture.header(b"HTTP/1.1 302 Found\r\n"));
        assert!(capture.header(b"ETag: \"redirect-object\"\r\n"));
        assert!(capture.header(b"Content-Length: 123\r\n"));
        assert!(capture.header(b"HTTP/1.1 206 Partial Content\r\n"));
        assert_eq!(capture.validator(), None);
        assert_eq!(capture.content_length(), None);
        assert!(capture.header(b"ETag: \"final-object\"\r\n"));
        assert_eq!(
            capture.validator(),
            Some(("\"final-object\"".to_owned(), true))
        );
    }

    #[test]
    fn range_transfers_force_identity_encoding() {
        let missing = std::env::temp_dir().join(format!(
            "nova_identity_range_{}_missing.bin",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&missing);
        assert!(requires_identity_encoding(true, &missing, Some((0, 1023))).unwrap());
        assert!(requires_identity_encoding(false, &missing, Some((0, 1023))).unwrap());
    }

    #[test]
    fn partial_resume_forces_identity_but_fresh_download_does_not() {
        let dir =
            std::env::temp_dir().join(format!("nova_identity_resume_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial.bin");

        assert!(!requires_identity_encoding(true, &path, None).unwrap());
        std::fs::write(&path, b"partial-checkpoint").unwrap();
        assert!(requires_identity_encoding(true, &path, None).unwrap());
        assert!(!requires_identity_encoding(false, &path, None).unwrap());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn speed_limit_kilobytes_saturates_without_overflow() {
        let mut config = CurlTransferConfig::new();
        config.speed_limit_kbs = Some(u64::MAX);
        assert_eq!(configured_speed_limit_bytes(&config), Some(u64::MAX));

        config.speed_limit_bytes = Some(7);
        assert_eq!(configured_speed_limit_bytes(&config), Some(7));
    }

    #[test]
    fn set_live_rate_rejects_null_handle() {
        // M12: a failed easy option must surface as an Err, never be silently
        // dropped. Passing a null raw handle makes libcurl fail immediately.
        let result = set_live_rate(std::ptr::null_mut(), Some(1024));
        assert!(result.is_err(), "null handle must produce an error");
        let result = set_live_rate(std::ptr::null_mut(), None);
        assert!(
            result.is_err(),
            "null handle must produce an error even for clear"
        );
    }
}
